import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DeviceStatus, DeviceType } from '@prisma/client';
import { requireRole }            from '../middleware/rbac.js';
import { logAudit }               from '../services/audit.service.js';
import { sendAssignmentAckEmail } from '../services/notification.service.js';

const MAX_IMAGE_SIZE   = 3 * 1024 * 1024; // 3 MB
const MAX_IMAGES       = 5;
const ALLOWED_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const createDeviceBody = z.object({
  serial:       z.string().min(1).max(100),
  type:         z.nativeEnum(DeviceType),
  manufacturer: z.string().max(100).optional(),
  model:        z.string().min(1).max(200),
  purchaseDate: z.string().optional(),
  notes:        z.string().max(2000).optional(),
});

const updateDeviceBody = z
  .object({
    manufacturer:        z.string().max(100).optional(),
    model:               z.string().min(1).max(200).optional(),
    notes:               z.string().max(2000).optional(),
    status:              z.nativeEnum(DeviceStatus).optional(),
    purchaseDate:        z.string().optional(),
    decommissionReason:  z.string().min(1).max(1000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.status === 'decommissioned' && !val.decommissionReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decommissionReason'],
        message: 'Reason for decommissioning is required',
      });
    }
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
        manufacturer: parsed.data.manufacturer,
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
          alerts:  { where: { resolvedAt: null }, orderBy: { sentAt: 'desc' } },
          images:  { orderBy: { createdAt: 'asc' } },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawAssignments: any[] = (device as any).assignments ?? [];
    const assignmentsWithActor = rawAssignments.map((a, i) => ({
      ...a,
      assignedBy: assignAuditEntries[i]?.user ?? null,
    }));

    const createdEntry = auditEntries.find((e) => e.action === 'device.created');

    return reply.send({
      ...device,
      createdBy:         createdEntry?.user ?? null,
      assignments:       assignmentsWithActor,
      currentAssignment: assignmentsWithActor.find((a: { returnedAt: unknown }) => a.returnedAt === null) ?? null,
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

    const updated = await (fastify.prisma.device.update as any)({
      where: { id },
      data: {
        ...parsed.data,
        purchaseDate:       parsed.data.purchaseDate ? new Date(parsed.data.purchaseDate) : undefined,
        // Clear reason when re-activating a previously decommissioned device.
        // Cast required until `npx prisma generate` is run locally to pick up
        // the decommission_reason column added in the latest migration.
        decommissionReason: parsed.data.status === 'active' ? null : parsed.data.decommissionReason,
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

  // ── POST /api/v1/devices/:id/images ───────────────────────────────────────
  // Accepts multipart/form-data with one or more files in the "images" field.
  // Each file must be ≤ 3 MB and be an image type. Up to MAX_IMAGES total.
  fastify.post('/devices/:id/images', { preHandler: operator }, async (request, reply) => {
    const { id: deviceId }       = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const device = await fastify.prisma.device.findFirst({
      where: { id: deviceId, orgId },
      include: { _count: { select: { images: true } } },
    });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    const existing = (device as typeof device & { _count: { images: number } })._count.images;
    if (existing >= MAX_IMAGES) {
      return reply.status(409).send({
        error: `Device already has the maximum of ${MAX_IMAGES} images`,
      });
    }

    const parts = request.parts();
    const saved: Array<{ filename: string; originalName: string; size: number; mimeType: string }> = [];
    let remaining = MAX_IMAGES - existing;

    for await (const part of parts) {
      if (part.type !== 'file') continue;
      if (remaining <= 0) break;

      const mimeType = part.mimetype;
      if (!ALLOWED_MIMETYPES.has(mimeType)) {
        await part.file.resume(); // drain the stream
        return reply.status(400).send({
          error: `Unsupported file type: ${mimeType}. Allowed: JPEG, PNG, WebP, GIF`,
        });
      }

      // Buffer the entire file before writing so we can enforce the size cap
      // without leaving partial files on disk / in cloud storage.
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of part.file) {
        totalSize += chunk.length;
        if (totalSize > MAX_IMAGE_SIZE) {
          return reply.status(413).send({
            error: `File "${part.filename}" exceeds the 3 MB limit`,
          });
        }
        chunks.push(chunk as Buffer);
      }

      const result = await fastify.storage.upload(Buffer.concat(chunks), {
        filename: part.filename || 'image.jpg',
        mimeType,
        folder:   'device-images',
      });

      saved.push({
        filename:     result.key,
        originalName: part.filename ?? 'image',
        size:         totalSize,
        mimeType,
      });
      remaining--;
    }

    if (saved.length === 0) {
      return reply.status(400).send({ error: 'No valid image files received' });
    }

    const images = await fastify.prisma.$transaction(
      saved.map((s) =>
        fastify.prisma.deviceImage.create({
          data: { deviceId, ...s },
        })
      )
    );

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.images_uploaded',
      resourceType: 'device',
      resourceId: deviceId,
      payload: { count: images.length },
    });

    // Attach resolved public URL so clients don't need to know the provider
    return reply.status(201).send(
      images.map((img) => ({ ...img, url: fastify.storage.getUrl(img.filename) }))
    );
  });

  // ── GET /api/v1/devices/:id/images ────────────────────────────────────────
  fastify.get('/devices/:id/images', { preHandler: auth }, async (request, reply) => {
    const { id: deviceId } = request.params as { id: string };
    const { orgId }        = request.user;

    const device = await fastify.prisma.device.findFirst({ where: { id: deviceId, orgId } });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    const images = await fastify.prisma.deviceImage.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send(
      images.map((img) => ({ ...img, url: fastify.storage.getUrl(img.filename) }))
    );
  });

  // ── DELETE /api/v1/devices/:id/images/:imageId ────────────────────────────
  fastify.delete(
    '/devices/:id/images/:imageId',
    { preHandler: operator },
    async (request, reply) => {
      const { id: deviceId, imageId } = request.params as { id: string; imageId: string };
      const { orgId, sub: userId }    = request.user;

      const device = await fastify.prisma.device.findFirst({ where: { id: deviceId, orgId } });
      if (!device) return reply.status(404).send({ error: 'Device not found' });

      const image = await fastify.prisma.deviceImage.findFirst({
        where: { id: imageId, deviceId },
      });
      if (!image) return reply.status(404).send({ error: 'Image not found' });

      // Delete DB record first, then the stored file — if file delete fails
      // the record is already gone (acceptable). The reverse would expose dead links.
      await fastify.prisma.deviceImage.delete({ where: { id: imageId } });

      // Best-effort: provider silently swallows "not found" errors
      fastify.storage.delete(image.filename).catch(() => {});

      await logAudit(fastify.prisma, {
        orgId, userId,
        action: 'device.image_deleted',
        resourceType: 'device',
        resourceId: deviceId,
        payload: { imageId, filename: image.originalName },
      });

      return reply.status(204).send();
    }
  );
}
