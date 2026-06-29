import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';

const nameBody  = z.object({ name: z.string().min(1).max(100).trim() });
const deleteBody = z.object({ reassignTo: z.string().optional() });

export default async function locationRoutes(fastify: FastifyInstance) {
  const auth     = [fastify.authenticate];
  const operator = [fastify.authenticate, requireRole('operator')];

  // ── GET /api/v1/locations ─────────────────────────────────────────────────
  fastify.get('/locations', { preHandler: auth }, async (request, reply) => {
    const { orgId } = request.user;

    const locations = await fastify.prisma.location.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { devices: true } } },
    });

    return reply.send({ data: locations });
  });

  // ── POST /api/v1/locations ────────────────────────────────────────────────
  fastify.post('/locations', { preHandler: operator }, async (request, reply) => {
    const parsed = nameBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { orgId, sub: userId } = request.user;

    const existing = await fastify.prisma.location.findUnique({
      where: { orgId_name: { orgId, name: parsed.data.name } },
    });
    if (existing) return reply.status(409).send({ error: 'Location already exists' });

    const loc = await fastify.prisma.location.create({
      data: { orgId, name: parsed.data.name },
      include: { _count: { select: { devices: true } } },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'location.created',
      resourceType: 'location',
      resourceId: loc.id,
      payload: { name: loc.name },
    });

    return reply.status(201).send(loc);
  });

  // ── PATCH /api/v1/locations/:id ───────────────────────────────────────────
  fastify.patch('/locations/:id', { preHandler: operator }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const parsed = nameBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const loc = await fastify.prisma.location.findFirst({ where: { id, orgId } });
    if (!loc) return reply.status(404).send({ error: 'Location not found' });

    const conflict = await fastify.prisma.location.findFirst({
      where: { orgId, name: parsed.data.name, id: { not: id } },
    });
    if (conflict) return reply.status(409).send({ error: 'Location name already in use' });

    const updated = await fastify.prisma.location.update({
      where: { id },
      data: { name: parsed.data.name },
      include: { _count: { select: { devices: true } } },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'location.updated',
      resourceType: 'location',
      resourceId: id,
      payload: { name: parsed.data.name },
    });

    return reply.send(updated);
  });

  // ── DELETE /api/v1/locations/:id ─────────────────────────────────────────
  fastify.delete('/locations/:id', { preHandler: operator }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const parsed = deleteBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const loc = await fastify.prisma.location.findFirst({ where: { id, orgId } });
    if (!loc) return reply.status(404).send({ error: 'Location not found' });

    if (parsed.data.reassignTo) {
      const target = await fastify.prisma.location.findFirst({
        where: { id: parsed.data.reassignTo, orgId },
      });
      if (!target) {
        return reply.status(404).send({ error: 'Reassignment target location not found' });
      }
    }

    await fastify.prisma.$transaction([
      fastify.prisma.device.updateMany({
        where: { locationId: id },
        data:  { locationId: parsed.data.reassignTo ?? null },
      }),
      fastify.prisma.location.delete({ where: { id } }),
    ]);

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'location.deleted',
      resourceType: 'location',
      resourceId: id,
      payload: { name: loc.name, reassignTo: parsed.data.reassignTo ?? null },
    });

    return reply.status(200).send({ ok: true });
  });
}
