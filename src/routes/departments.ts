import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';

const nameBody = z.object({ name: z.string().min(1).max(100).trim() });
const deleteBody = z.object({ reassignTo: z.string().optional() });

export default async function departmentRoutes(fastify: FastifyInstance) {
  const auth     = [fastify.authenticate];
  const operator = [fastify.authenticate, requireRole('operator')];

  // ── GET /api/v1/departments ────────────────────────────────────────────────
  fastify.get('/departments', { preHandler: auth }, async (request, reply) => {
    const { orgId } = request.user;

    const departments = await fastify.prisma.department.findMany({
      where: { orgId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { devices: true } } },
    });

    return reply.send({ data: departments });
  });

  // ── POST /api/v1/departments ───────────────────────────────────────────────
  fastify.post('/departments', { preHandler: operator }, async (request, reply) => {
    const parsed = nameBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const { orgId, sub: userId } = request.user;

    const existing = await fastify.prisma.department.findUnique({
      where: { orgId_name: { orgId, name: parsed.data.name } },
    });
    if (existing) return reply.status(409).send({ error: 'Department already exists' });

    const dept = await fastify.prisma.department.create({
      data: { orgId, name: parsed.data.name },
      include: { _count: { select: { devices: true } } },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'department.created',
      resourceType: 'department',
      resourceId: dept.id,
      payload: { name: dept.name },
    });

    return reply.status(201).send(dept);
  });

  // ── PATCH /api/v1/departments/:id ─────────────────────────────────────────
  fastify.patch('/departments/:id', { preHandler: operator }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const parsed = nameBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const dept = await fastify.prisma.department.findFirst({ where: { id, orgId } });
    if (!dept) return reply.status(404).send({ error: 'Department not found' });

    // Uniqueness check (exclude self)
    const conflict = await fastify.prisma.department.findFirst({
      where: { orgId, name: parsed.data.name, id: { not: id } },
    });
    if (conflict) return reply.status(409).send({ error: 'Department name already in use' });

    const updated = await fastify.prisma.department.update({
      where: { id },
      data: { name: parsed.data.name },
      include: { _count: { select: { devices: true } } },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'department.updated',
      resourceType: 'department',
      resourceId: id,
      payload: { name: parsed.data.name },
    });

    return reply.send(updated);
  });

  // ── DELETE /api/v1/departments/:id ────────────────────────────────────────
  // Optional body: { reassignTo: string } — move devices to another department.
  // If omitted, device.departmentId is set to null (unlinked).
  // All ops run in a single $transaction so the FK constraint is never violated.
  fastify.delete('/departments/:id', { preHandler: operator }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const parsed = deleteBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

    const dept = await fastify.prisma.department.findFirst({ where: { id, orgId } });
    if (!dept) return reply.status(404).send({ error: 'Department not found' });

    if (parsed.data.reassignTo) {
      const target = await fastify.prisma.department.findFirst({
        where: { id: parsed.data.reassignTo, orgId },
      });
      if (!target) {
        return reply.status(404).send({ error: 'Reassignment target department not found' });
      }
    }

    await fastify.prisma.$transaction([
      // Step 1: reassign or clear devices
      fastify.prisma.device.updateMany({
        where: { departmentId: id },
        data:  { departmentId: parsed.data.reassignTo ?? null },
      }),
      // Step 2: delete the department (FK constraint satisfied by step 1)
      fastify.prisma.department.delete({ where: { id } }),
    ]);

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'department.deleted',
      resourceType: 'department',
      resourceId: id,
      payload: { name: dept.name, reassignTo: parsed.data.reassignTo ?? null },
    });

    return reply.status(200).send({ ok: true });
  });
}
