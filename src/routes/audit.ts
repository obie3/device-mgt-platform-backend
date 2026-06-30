import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac.js';

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
    { preHandler: [fastify.authenticate, requireRole('operator')] },
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

      // ── Batch-resolve resource names ────────────────────────────────────────
      const deviceIds   = [...new Set(logs.filter(l => l.resourceType === 'device').map(l => l.resourceId))];
      const employeeIds = [...new Set(logs.filter(l => l.resourceType === 'employee').map(l => l.resourceId))];
      const userIds     = [...new Set(logs.filter(l => l.resourceType === 'user').map(l => l.resourceId))];

      // For device.assigned entries, extract employeeIds from the payload so we
      // can resolve the assignee name without a separate round-trip.
      const assignPayloadEmpIds = [
        ...new Set(
          logs
            .filter(l => l.action === 'device.assigned')
            .map(l => (l.payload as Record<string, unknown>).employeeId as string | undefined)
            .filter((id): id is string => !!id)
        ),
      ];

      const [devices, employees, platformUsers, assignees] = await Promise.all([
        deviceIds.length
          ? fastify.prisma.device.findMany({
              where: { id: { in: deviceIds } },
              select: { id: true, model: true, serial: true },
            })
          : [],
        employeeIds.length
          ? fastify.prisma.employee.findMany({
              where: { id: { in: employeeIds } },
              select: { id: true, name: true, email: true },
            })
          : [],
        userIds.length
          ? fastify.prisma.user.findMany({
              where: { id: { in: userIds } },
              select: { id: true, name: true, email: true },
            })
          : [],
        assignPayloadEmpIds.length
          ? fastify.prisma.employee.findMany({
              where: { id: { in: assignPayloadEmpIds } },
              select: { id: true, name: true, email: true },
            })
          : [],
      ]);

      const deviceMap   = new Map(devices.map(d => [d.id, d]));
      const employeeMap = new Map(employees.map(e => [e.id, e]));
      const userMap     = new Map(platformUsers.map(u => [u.id, u]));
      const assigneeMap = new Map(assignees.map(e => [e.id, e]));

      function resourceName(log: (typeof logs)[number]): string | null {
        switch (log.resourceType) {
          case 'device':   return deviceMap.get(log.resourceId)?.model ?? null;
          case 'employee': return employeeMap.get(log.resourceId)?.name ?? null;
          case 'user':     return userMap.get(log.resourceId)?.name ?? null;
          default:         return null;
        }
      }

      function assignee(log: (typeof logs)[number]) {
        if (log.action !== 'device.assigned') return null;
        const empId = (log.payload as Record<string, unknown>).employeeId as string | undefined;
        return empId ? (assigneeMap.get(empId) ?? null) : null;
      }

      return reply.send({
        data: logs.map(log => ({
          ...log,
          resourceName: resourceName(log),
          assignee: assignee(log),
        })),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      });
    }
  );
}
