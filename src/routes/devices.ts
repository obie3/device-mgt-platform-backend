import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DeviceStatus, DeviceType } from '@prisma/client';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { requireRole } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';
import { sendAssignmentAckEmail } from '../services/notification.service.js';

const createDeviceBody = z.object({
  serial: z.string().min(1),
  type: z.nativeEnum(DeviceType),
  model: z.string().min(1),
  purchaseDate: z.string().optional(), // accepts "2024-01-15" or full ISO
  notes: z.string().optional(),
});

const updateDeviceBody = z.object({
  model: z.string().min(1).optional(),
  notes: z.string().optional(),
  status: z.nativeEnum(DeviceStatus).optional(),
  purchaseDate: z.string().optional(), // accepts "2024-01-15" or full ISO
});

const assignBody = z.object({
  employeeId: z.string(),
  conditionNotes: z.string().optional(),
});

const checkinBody = z.object({
  serial: z.string(),
  hostname: z.string().optional(),
});

const listQuery = z.object({
  type: z.nativeEnum(DeviceType).optional(),
  status: z.nativeEnum(DeviceStatus).optional(),
  assigned: z.enum(['true', 'false']).optional(),
  stale: z.enum(['true', 'false']).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export default async function deviceRoutes(fastify: FastifyInstance) {
  const auth = [fastify.authenticate];
  const operator = [fastify.authenticate, requireRole('operator')];

  // GET /api/v1/devices
  fastify.get('/devices', { preHandler: auth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    const { orgId } = request.user;
    const { type, status, assigned, stale, search, page, limit } = query.data;

    const where: Record<string, unknown> = { orgId };
    if (type) where.type = type;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { serial: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
        { hostname: { contains: search, mode: 'insensitive' } },
      ];
    }
    // Only fetch org stale threshold when the stale filter is actually requested
    if (stale === 'true') {
      const org = await fastify.prisma.organization.findUnique({
        where: { id: orgId },
        select: { staleThresholdDays: true },
      });
      const staleThreshold = org?.staleThresholdDays ?? 14;
      const staleCutoff = new Date(
        Date.now() - staleThreshold * 24 * 60 * 60 * 1000
      );
      where.OR = [
        { lastSeen: null },
        { lastSeen: { lt: staleCutoff } },
      ];
    }

    const [devices, total] = await Promise.all([
      fastify.prisma.device.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          assignments: {
            where: { returnedAt: null },
            include: { employee: { select: { id: true, name: true, email: true } } },
            take: 1,
          },
        },
      }),
      fastify.prisma.device.count({ where }),
    ]);

    // Filter by assigned post-query (simpler than complex Prisma filter)
    let filtered = devices;
    if (assigned === 'true') {
      filtered = devices.filter((d) => d.assignments.length > 0);
    } else if (assigned === 'false') {
      filtered = devices.filter((d) => d.assignments.length === 0);
    }

    return reply.send({
      data: filtered.map((d) => ({
        ...d,
        tokenHash: undefined, // never expose
        currentAssignment: d.assignments[0] ?? null,
        assignments: undefined,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  });

  // POST /api/v1/devices
  fastify.post('/devices', { preHandler: operator }, async (request, reply) => {
    const parsed = createDeviceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { orgId, sub: userId } = request.user;

    const existing = await fastify.prisma.device.findUnique({
      where: { orgId_serial: { orgId, serial: parsed.data.serial } },
    });
    if (existing) {
      return reply.status(409).send({ error: 'Serial number already registered' });
    }

    // Generate a plaintext token (shown once) and store its hash
    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(plainToken, 10);

    const device = await fastify.prisma.device.create({
      data: {
        orgId,
        serial: parsed.data.serial,
        type: parsed.data.type,
        model: parsed.data.model,
        purchaseDate: parsed.data.purchaseDate
          ? new Date(parsed.data.purchaseDate)
          : undefined,
        notes: parsed.data.notes,
        tokenHash,
      },
    });

    await logAudit(fastify.prisma, {
      orgId,
      userId,
      action: 'device.created',
      resourceType: 'device',
      resourceId: device.id,
      payload: { serial: device.serial, type: device.type, model: device.model },
    });

    return reply.status(201).send({
      ...device,
      tokenHash: undefined,
      // Return plaintext token ONCE
      checkinToken: plainToken,
    });
  });

  // GET /api/v1/devices/:id
  fastify.get('/devices/:id', { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orgId } = request.user;

    const device = await fastify.prisma.device.findFirst({
      where: { id, orgId },
      include: {
        assignments: {
          orderBy: { assignedAt: 'desc' },
          include: {
            employee: { select: { id: true, name: true, email: true } },
          },
        },
        alerts: { where: { resolvedAt: null }, orderBy: { sentAt: 'desc' } },
      },
    });

    if (!device) return reply.status(404).send({ error: 'Device not found' });

    return reply.send({
      ...device,
      tokenHash: undefined,
      currentAssignment:
        device.assignments.find((a) => a.returnedAt === null) ?? null,
    });
  });

  // PATCH /api/v1/devices/:id
  fastify.patch(
    '/devices/:id',
    { preHandler: operator },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { orgId, sub: userId } = request.user;

      const parsed = updateDeviceBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const device = await fastify.prisma.device.findFirst({
        where: { id, orgId },
      });
      if (!device) return reply.status(404).send({ error: 'Device not found' });

      const updated = await fastify.prisma.device.update({
        where: { id },
        data: {
          ...parsed.data,
          purchaseDate: parsed.data.purchaseDate
            ? new Date(parsed.data.purchaseDate)
            : undefined,
        },
      });

      await logAudit(fastify.prisma, {
        orgId,
        userId,
        action: 'device.updated',
        resourceType: 'device',
        resourceId: id,
        payload: parsed.data,
      });

      return reply.send({ ...updated, tokenHash: undefined });
    }
  );

  // POST /api/v1/devices/:id/assign
  fastify.post(
    '/devices/:id/assign',
    { preHandler: operator },
    async (request, reply) => {
      const { id: deviceId } = request.params as { id: string };
      const { orgId, sub: userId } = request.user;

      const parsed = assignBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const device = await fastify.prisma.device.findFirst({
        where: { id: deviceId, orgId, status: 'active' },
      });
      if (!device) {
        return reply.status(404).send({ error: 'Device not found or not active' });
      }

      const employee = await fastify.prisma.employee.findFirst({
        where: { id: parsed.data.employeeId, orgId, status: 'active' },
      });
      if (!employee) {
        return reply.status(404).send({ error: 'Employee not found or not active' });
      }

      // Close any existing open assignment
      await fastify.prisma.deviceAssignment.updateMany({
        where: { deviceId, returnedAt: null },
        data: { returnedAt: new Date() },
      });

      const ackToken = crypto.randomUUID();
      const ackExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const assignment = await fastify.prisma.deviceAssignment.create({
        data: {
          deviceId,
          employeeId: parsed.data.employeeId,
          conditionNotes: parsed.data.conditionNotes,
          acknowledgeToken: ackToken,
          acknowledgeExpiresAt: ackExpiresAt,
        },
      });

      // Resolve any open unassigned alert
      await fastify.prisma.alert.updateMany({
        where: { deviceId, type: 'unassigned_device', resolvedAt: null },
        data: { resolvedAt: new Date() },
      });

      await logAudit(fastify.prisma, {
        orgId,
        userId,
        action: 'device.assigned',
        resourceType: 'device',
        resourceId: deviceId,
        payload: {
          employeeId: parsed.data.employeeId,
          conditionNotes: parsed.data.conditionNotes,
        },
      });

      // Send ack email (non-blocking)
      sendAssignmentAckEmail({
        assigneeEmail: employee.email,
        assigneeName: employee.name,
        deviceModel: device.model,
        deviceSerial: device.serial,
        conditionNotes: parsed.data.conditionNotes ?? null,
        ackToken,
      }).catch((err) =>
        fastify.log.error({ err }, 'Failed to send ack email')
      );

      return reply.status(201).send(assignment);
    }
  );

  // POST /api/v1/devices/:id/unassign
  fastify.post(
    '/devices/:id/unassign',
    { preHandler: operator },
    async (request, reply) => {
      const { id: deviceId } = request.params as { id: string };
      const { orgId, sub: userId } = request.user;

      const device = await fastify.prisma.device.findFirst({
        where: { id: deviceId, orgId },
      });
      if (!device) return reply.status(404).send({ error: 'Device not found' });

      const updated = await fastify.prisma.deviceAssignment.updateMany({
        where: { deviceId, returnedAt: null },
        data: { returnedAt: new Date() },
      });

      if (updated.count === 0) {
        return reply.status(409).send({ error: 'Device is not currently assigned' });
      }

      await logAudit(fastify.prisma, {
        orgId,
        userId,
        action: 'device.returned',
        resourceType: 'device',
        resourceId: deviceId,
      });

      return reply.status(200).send({ ok: true });
    }
  );

  // POST /api/v1/checkin — device token auth, no user session
  fastify.post('/checkin', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing device token' });
    }
    const plainToken = authHeader.slice(7);

    const parsed = checkinBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    // Find device by serial, then verify token
    const device = await fastify.prisma.device.findFirst({
      where: { serial: parsed.data.serial, status: 'active' },
    });

    if (!device || !device.tokenHash) {
      return reply.status(401).send({ error: 'Invalid token' });
    }

    const valid = await bcrypt.compare(plainToken, device.tokenHash);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid token' });
    }

    await fastify.prisma.device.update({
      where: { id: device.id },
      data: {
        lastSeen: new Date(),
        hostname: parsed.data.hostname ?? device.hostname,
      },
    });

    // Auto-resolve stale alert if present
    await fastify.prisma.alert.updateMany({
      where: { deviceId: device.id, type: 'stale_device', resolvedAt: null },
      data: { resolvedAt: new Date() },
    });

    return reply.send({ ok: true });
  });
}
