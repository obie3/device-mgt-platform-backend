import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DeviceStatus, DeviceType } from '@prisma/client';
import crypto from 'crypto';
import { requireRole } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';
import { sendAssignmentAckEmail } from '../services/notification.service.js';

const createDeviceBody = z.object({
  serial: z.string().min(1).max(100),
  type: z.nativeEnum(DeviceType),
  model: z.string().min(1).max(200),
  purchaseDate: z.string().optional(),
  notes: z.string().max(2000).optional(),
});

const updateDeviceBody = z.object({
  model: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).optional(),
  status: z.nativeEnum(DeviceStatus).optional(),
  purchaseDate: z.string().optional(),
});

const assignBody = z.object({
  employeeId: z.string(),
  conditionNotes: z.string().max(2000).optional(),
});

const listQuery = z.object({
  type: z.nativeEnum(DeviceType).optional(),
  status: z.nativeEnum(DeviceStatus).optional(),
  assigned: z.enum(['true', 'false']).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export default async function deviceRoutes(fastify: FastifyInstance) {
  const auth     = [fastify.authenticate];
  const operator = [fastify.authenticate, requireRole('operator')];

  // ── GET /api/v1/devices ────────────────────────────────────────────────────
  fastify.get('/devices', { preHandler: auth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    const { orgId } = request.user;
    const { type, status, assigned, search, page, limit } = query.data;

    const where: Record<string, unknown> = { orgId };
    if (type)   where.type = type;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { serial: { contains: search, mode: 'insensitive' } },
        { model:  { contains: search, mode: 'insensitive' } },
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

    let filtered = devices;
    if (assigned === 'true')  filtered = devices.filter((d) => d.assignments.length > 0);
    if (assigned === 'false') filtered = devices.filter((d) => d.assignments.length === 0);

    return reply.send({
      data: filtered.map((d) => ({
        ...d,
        currentAssignment: d.assignments[0] ?? null,
        assignments: undefined,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  });

  // ── POST /api/v1/devices ───────────────────────────────────────────────────
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

    const device = await fastify.prisma.device.create({
      data: {
        orgId,
        serial:       parsed.data.serial,
        type:         parsed.data.type,
        model:        parsed.data.model,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : undefined,
        notes:        parsed.data.notes,
      },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.created',
      resourceType: 'device',
      resourceId: device.id,
      payload: { serial: device.serial, type: device.type, model: device.model },
    });

    return reply.status(201).send(device);
  });

  // ── GET /api/v1/devices/:id ────────────────────────────────────────────────
  fastify.get('/devices/:id', { preHandler: auth }, async (request, reply) => {
    const { id }    = request.params as { id: string };
    const { orgId } = request.user;

    const [device, auditEntries] = await Promise.all([
      fastify.prisma.device.findFirst({
        where: { id, orgId },
        include: {
          // asc so we can correlate with audit entries by index
          assignments: {
            orderBy: { assignedAt: 'asc' },
            include: { employee: { select: { id: true, name: true, email: true } } },
          },
          alerts: { where: { resolvedAt: null }, orderBy: { sentAt: 'desc' } },
        },
      }),
      fastify.prisma.auditLog.findMany({
        where: {
          orgId,
          resourceType: 'device',
          resourceId: id,
          action: { in: ['device.created', 'device.assigned', 'device.unassigned'] },
        },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { ts: 'asc' },
      }),
    ]);

    if (!device) return reply.status(404).send({ error: 'Device not found' });

    // Attach assignedBy to each assignment by correlating with audit log in order
    const assignAuditEntries = auditEntries.filter((e) => e.action === 'device.assigned');
    const assignmentsWithActor = device.assignments.map((a, i) => ({
      ...a,
      assignedBy: assignAuditEntries[i]?.user ?? null,
    }));

    const createdEntry = auditEntries.find((e) => e.action === 'device.created');

    return reply.send({
      ...device,
      createdBy:         createdEntry?.user ?? null,
      assignments:       assignmentsWithActor,
      currentAssignment: assignmentsWithActor.find((a) => a.returnedAt === null) ?? null,
    });
  });

  // ── PATCH /api/v1/devices/:id ──────────────────────────────────────────────
  fastify.patch('/devices/:id', { preHandler: operator }, async (request, reply) => {
    const { id }                 = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const parsed = updateDeviceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const device = await fastify.prisma.device.findFirst({ where: { id, orgId } });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    const updated = await fastify.prisma.device.update({
      where: { id },
      data: {
        ...parsed.data,
        purchaseDate: parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : undefined,
      },
    });

    // When decommissioning, auto-close any open assignment.
    if (parsed.data.status === 'decommissioned') {
      const closed = await fastify.prisma.deviceAssignment.updateMany({
        where: { deviceId: id, returnedAt: null },
        data: { returnedAt: new Date() },
      });
      if (closed.count > 0) {
        await logAudit(fastify.prisma, {
          orgId, userId,
          action: 'device.returned',
          resourceType: 'device',
          resourceId: id,
          payload: { reason: 'device_decommissioned' },
        });
      }
    }

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.updated',
      resourceType: 'device',
      resourceId: id,
      payload: parsed.data,
    });

    return reply.send(updated);
  });

  // ── POST /api/v1/devices/:id/assign ───────────────────────────────────────
  fastify.post('/devices/:id/assign', { preHandler: operator }, async (request, reply) => {
    const { id: deviceId }       = request.params as { id: string };
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

    const ackToken     = crypto.randomUUID();
    const ackExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const assignment = await fastify.prisma.deviceAssignment.create({
      data: {
        deviceId,
        employeeId:           parsed.data.employeeId,
        conditionNotes:       parsed.data.conditionNotes,
        acknowledgeToken:     ackToken,
        acknowledgeExpiresAt: ackExpiresAt,
      },
    });

    // Resolve any open unassigned alert
    await fastify.prisma.alert.updateMany({
      where: { deviceId, type: 'unassigned_device', resolvedAt: null },
      data: { resolvedAt: new Date() },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.assigned',
      resourceType: 'device',
      resourceId: deviceId,
      payload: {
        employeeId:     parsed.data.employeeId,
        conditionNotes: parsed.data.conditionNotes,
      },
    });

    sendAssignmentAckEmail({
      assigneeEmail:  employee.email,
      assigneeName:   employee.name,
      deviceModel:    device.model,
      deviceSerial:   device.serial,
      conditionNotes: parsed.data.conditionNotes ?? null,
      ackToken,
    }).catch((err) => fastify.log.error({ err }, 'Failed to send ack email'));

    return reply.status(201).send(assignment);
  });

  // ── POST /api/v1/devices/:id/unassign ─────────────────────────────────────
  fastify.post('/devices/:id/unassign', { preHandler: operator }, async (request, reply) => {
    const { id: deviceId }       = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const device = await fastify.prisma.device.findFirst({ where: { id: deviceId, orgId } });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    const updated = await fastify.prisma.deviceAssignment.updateMany({
      where: { deviceId, returnedAt: null },
      data: { returnedAt: new Date() },
    });

    if (updated.count === 0) {
      return reply.status(409).send({ error: 'Device is not currently assigned' });
    }

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.returned',
      resourceType: 'device',
      resourceId: deviceId,
    });

    return reply.status(200).send({ ok: true });
  });
}
