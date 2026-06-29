import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac.js';
import { logAudit }    from '../services/audit.service.js';

export default async function repairRoutes(fastify: FastifyInstance) {
  const auth     = [fastify.authenticate];
  const operator = [fastify.authenticate, requireRole('operator')];

  // ── GET /api/v1/devices/:id/repairs ───────────────────────────────────────
  fastify.get('/devices/:id/repairs', { preHandler: auth }, async (request, reply) => {
    const { orgId } = request.user;
    const { id: deviceId } = request.params as { id: string };

    // Verify device belongs to org
    const device = await fastify.prisma.device.findFirst({ where: { id: deviceId, orgId } });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    const repairs = await fastify.prisma.deviceRepair.findMany({
      where:   { deviceId, orgId },
      orderBy: { sentAt: 'desc' },
      include: { loggedBy: { select: { id: true, name: true } } },
    });

    return reply.send(repairs);
  });

  // ── POST /api/v1/devices/:id/repairs ──────────────────────────────────────
  const logRepairBody = z.object({
    issue:             z.string().min(1).max(2000),
    notes:             z.string().max(2000).optional(),
    vendor:            z.string().max(200).optional(),
    technicianName:    z.string().max(200).optional(),
    cost:              z.number().nonnegative().optional(),
    sentAt:            z.string().optional(),          // ISO date; defaults to now
    estimatedReturnAt: z.string().optional(),
  });

  fastify.post('/devices/:id/repairs', { preHandler: operator }, async (request, reply) => {
    const { orgId, sub: userId } = request.user;
    const { id: deviceId } = request.params as { id: string };

    const device = await fastify.prisma.device.findFirst({ where: { id: deviceId, orgId } });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    const parsed = logRepairBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { issue, notes, vendor, technicianName, cost, sentAt, estimatedReturnAt } = parsed.data;

    const repair = await fastify.prisma.deviceRepair.create({
      data: {
        orgId,
        deviceId,
        loggedById:        userId,
        issue,
        notes:             notes             || undefined,
        vendor:            vendor            || undefined,
        technicianName:    technicianName    || undefined,
        cost:              cost              != null ? cost : undefined,
        sentAt:            sentAt            ? new Date(sentAt)            : new Date(),
        estimatedReturnAt: estimatedReturnAt ? new Date(estimatedReturnAt) : undefined,
      },
      include: { loggedBy: { select: { id: true, name: true } } },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action:       'device.repair_logged',
      resourceType: 'device',
      resourceId:   deviceId,
      payload:      { repairId: repair.id, issue: issue.slice(0, 100) },
    });

    return reply.status(201).send(repair);
  });

  // ── PATCH /api/v1/repairs/:repairId/close ─────────────────────────────────
  // Marks a repair as returned (sets returnedAt + optional notes/cost update)
  const closeRepairBody = z.object({
    returnedAt: z.string().optional(),     // ISO date; defaults to now
    notes:      z.string().max(2000).optional(),
    cost:       z.number().nonnegative().optional(),
  });

  fastify.patch('/repairs/:repairId/close', { preHandler: operator }, async (request, reply) => {
    const { orgId, sub: userId } = request.user;
    const { repairId } = request.params as { repairId: string };

    const existing = await fastify.prisma.deviceRepair.findFirst({ where: { id: repairId, orgId } });
    if (!existing) return reply.status(404).send({ error: 'Repair record not found' });
    if (existing.returnedAt) return reply.status(409).send({ error: 'Repair already closed' });

    const parsed = closeRepairBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { returnedAt, notes, cost } = parsed.data;

    const repair = await fastify.prisma.deviceRepair.update({
      where: { id: repairId },
      data: {
        returnedAt: returnedAt ? new Date(returnedAt) : new Date(),
        ...(notes != null && { notes }),
        ...(cost  != null && { cost  }),
      },
      include: { loggedBy: { select: { id: true, name: true } } },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action:       'device.repair_closed',
      resourceType: 'device',
      resourceId:   existing.deviceId,
      payload:      { repairId },
    });

    return reply.send(repair);
  });
}
