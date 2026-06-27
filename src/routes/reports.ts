import { FastifyInstance } from 'fastify';
import { stringify } from 'csv-stringify/sync';
import { requireRole } from '../middleware/rbac.js';

export default async function reportRoutes(fastify: FastifyInstance) {
  // GET /api/v1/reports/fleet
  // Accept: application/json | text/csv
  fastify.get(
    '/reports/fleet',
    { preHandler: [fastify.authenticate, requireRole('operator')] },
    async (request, reply) => {
      const { orgId } = request.user;
      const accept = request.headers.accept ?? 'application/json';

      const devices = await fastify.prisma.device.findMany({
        where: { orgId },
        orderBy: { createdAt: 'desc' },
        include: {
          assignments: {
            where: { returnedAt: null },
            include: {
              employee: { select: { name: true, email: true, department: true } },
            },
            take: 1,
          },
        },
      });

      const rows = devices.map((d) => {
        const assignment = d.assignments[0] ?? null;
        return {
          id: d.id,
          serial: d.serial,
          type: d.type,
          model: d.model,
          status: d.status,
          purchaseDate: d.purchaseDate?.toISOString() ?? '',
          assigneeName: assignment?.employee.name ?? '',
          assigneeEmail: assignment?.employee.email ?? '',
          assigneeDepartment: assignment?.employee.department ?? '',
          assignedAt: assignment?.assignedAt.toISOString() ?? '',
          notes: d.notes ?? '',
        };
      });

      if (accept.includes('text/csv')) {
        const csv = stringify(rows, { header: true });
        return reply
          .header('Content-Type', 'text/csv')
          .header(
            'Content-Disposition',
            `attachment; filename="fleet-report-${new Date().toISOString().slice(0, 10)}.csv"`
          )
          .send(csv);
      }

      return reply.send({ data: rows, total: rows.length });
    }
  );
}
