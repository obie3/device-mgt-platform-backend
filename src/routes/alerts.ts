import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AlertType } from '@prisma/client';
import { requireRole } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';

const listQuery = z.object({
  type:     z.nativeEnum(AlertType).optional(),
  resolved: z.enum(['true', 'false']).optional(),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
});

export default async function alertRoutes(fastify: FastifyInstance) {
  // GET /api/v1/alerts
  // Operator+ can view alerts. Scoped to the caller's org via device.orgId.
  fastify.get(
    '/alerts',
    { preHandler: [fastify.authenticate, requireRole('operator')] },
    async (request, reply) => {
      const query = listQuery.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: query.error.flatten() });
      }

      const { orgId } = request.user;
      const { type, resolved, page, limit } = query.data;

      const where: Record<string, unknown> = {
        device: { orgId },
      };
      if (type) where.type = type;
      if (resolved === 'false') where.resolvedAt = null;
      if (resolved === 'true')  where.resolvedAt = { not: null };

      const [alerts, total] = await Promise.all([
        fastify.prisma.alert.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: 'desc' },
          include: {
            device: {
              select: { id: true, model: true, serial: true, assetTag: true },
            },
          },
        }),
        fastify.prisma.alert.count({ where }),
      ]);

      return reply.send({
        data: alerts,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      });
    }
  );

  // PATCH /api/v1/alerts/:id/resolve
  // Marks an alert resolved. Admin/operator only.
  fastify.patch(
    '/alerts/:id/resolve',
    { preHandler: [fastify.authenticate, requireRole('operator')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { orgId, sub: actorId } = request.user;

      // Verify alert belongs to this org (through device.orgId)
      const alert = await fastify.prisma.alert.findFirst({
        where: { id, device: { orgId } },
        select: { id: true, resolvedAt: true, deviceId: true, type: true },
      });

      if (!alert) return reply.status(404).send({ error: 'Alert not found' });
      if (alert.resolvedAt) {
        return reply.status(409).send({ error: 'Alert is already resolved' });
      }

      const updated = await fastify.prisma.alert.update({
        where: { id },
        data: { resolvedAt: new Date() },
        include: {
          device: { select: { id: true, model: true, serial: true, assetTag: true } },
        },
      });

      await logAudit(fastify.prisma, {
        orgId,
        userId:       actorId,
        action:       'alert.resolved',
        resourceType: 'alert',
        resourceId:   id,
        payload:      { type: alert.type, deviceId: alert.deviceId },
      });

      return reply.send(updated);
    }
  );
}
