import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const listQuery = z.object({
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  action: z.string().optional(),
  userId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export default async function auditRoutes(fastify: FastifyInstance) {
  // GET /api/v1/audit
  fastify.get(
    '/audit',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const query = listQuery.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: query.error.flatten() });
      }

      const { orgId } = request.user;
      const { resourceType, resourceId, action, userId, from, to, page, limit } =
        query.data;

      const where: Record<string, unknown> = { orgId };
      if (resourceType) where.resourceType = resourceType;
      if (resourceId) where.resourceId = resourceId;
      if (action) where.action = { contains: action, mode: 'insensitive' };
      if (userId) where.userId = userId;
      if (from || to) {
        where.ts = {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        };
      }

      const [logs, total] = await Promise.all([
        fastify.prisma.auditLog.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { ts: 'desc' },
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        }),
        fastify.prisma.auditLog.count({ where }),
      ]);

      return reply.send({
        data: logs,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      });
    }
  );
}
