import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { stringify } from 'csv-stringify/sync';
import { requireRole } from '../middleware/rbac.js';

// Computed from warrantyEnd — mirrors the same logic in devices.ts.
function warrantyStatus(warrantyEnd: Date | null): 'active' | 'expiring' | 'expired' | null {
  if (!warrantyEnd) return null;
  const diff = warrantyEnd.getTime() - Date.now();
  if (diff < 0) return 'expired';
  if (diff < 30 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}

export default async function reportRoutes(fastify: FastifyInstance) {
  // ── GET /api/v1/reports/fleet ─────────────────────────────────────────────
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
          department: { select: { name: true } },
          location:   { select: { name: true } },
          assignments: {
            where: { returnedAt: null },
            include: {
              employee: {
                select: { name: true, email: true, department: { select: { name: true } } },
              },
            },
            take: 1,
          },
        },
      });

      const rows = devices.map((d) => {
        const assignment = d.assignments[0] ?? null;
        return {
          id:               d.id,
          serial:           d.serial,
          type:             d.type,
          manufacturer:     d.manufacturer    ?? '',
          model:            d.model,
          status:           d.status,
          assetTag:         d.assetTag        ?? '',
          location:         d.location?.name  ?? '',
          department:       d.department?.name ?? '',
          costCenter:       d.costCenter      ?? '',
          supplier:         d.supplier        ?? '',
          purchaseDate:     d.purchaseDate?.toISOString().slice(0, 10) ?? '',
          purchasePrice:    d.purchasePrice?.toString() ?? '',
          warrantyStart:    d.warrantyStart?.toISOString().slice(0, 10) ?? '',
          warrantyEnd:      d.warrantyEnd?.toISOString().slice(0, 10)   ?? '',
          warrantyProvider: d.warrantyProvider ?? '',
          warrantyStatus:   warrantyStatus(d.warrantyEnd ?? null) ?? '',
          assigneeName:     assignment?.employee.name ?? '',
          assigneeEmail:    assignment?.employee.email ?? '',
          assigneeDepartment: assignment?.employee.department?.name ?? '',
          assignedAt:       assignment?.assignedAt.toISOString() ?? '',
          notes:            d.notes ?? '',
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

  // ── GET /api/v1/reports/assets ────────────────────────────────────────────
  // Fleet value aggregated by status / type / department / location / costCenter.
  fastify.get(
    '/reports/assets',
    { preHandler: [fastify.authenticate, requireRole('operator')] },
    async (request, reply) => {
      const { orgId } = request.user;

      const [summary, byStatus, byType, byDepartment, byLocation, byCostCenter] =
        await Promise.all([
          fastify.prisma.$queryRaw<
            Array<{ totalDevices: number; devicesWithPrice: number; totalValue: string }>
          >(Prisma.sql`
            SELECT
              COUNT(*)::int                            AS "totalDevices",
              COUNT("purchase_price")::int             AS "devicesWithPrice",
              COALESCE(SUM("purchase_price"), 0)::text AS "totalValue"
            FROM "devices"
            WHERE "org_id" = ${orgId}
          `),

          fastify.prisma.$queryRaw<
            Array<{ status: string; count: number; value: string | null }>
          >(Prisma.sql`
            SELECT
              status::text,
              COUNT(*)::int               AS count,
              SUM("purchase_price")::text AS value
            FROM "devices"
            WHERE "org_id" = ${orgId}
            GROUP BY status
            ORDER BY status
          `),

          fastify.prisma.$queryRaw<
            Array<{ type: string; count: number; value: string | null }>
          >(Prisma.sql`
            SELECT
              type::text,
              COUNT(*)::int               AS count,
              SUM("purchase_price")::text AS value
            FROM "devices"
            WHERE "org_id" = ${orgId}
            GROUP BY type
            ORDER BY type
          `),

          fastify.prisma.$queryRaw<
            Array<{ departmentId: string | null; departmentName: string | null; count: number; value: string | null }>
          >(Prisma.sql`
            SELECT
              d."department_id"           AS "departmentId",
              dept."name"                 AS "departmentName",
              COUNT(*)::int               AS count,
              SUM(d."purchase_price")::text AS value
            FROM "devices" d
            LEFT JOIN "departments" dept ON dept."id" = d."department_id"
            WHERE d."org_id" = ${orgId}
            GROUP BY d."department_id", dept."name"
            ORDER BY dept."name" NULLS LAST
          `),

          fastify.prisma.$queryRaw<
            Array<{ locationId: string | null; locationName: string | null; count: number; value: string | null }>
          >(Prisma.sql`
            SELECT
              d."location_id"             AS "locationId",
              loc."name"                  AS "locationName",
              COUNT(*)::int               AS count,
              SUM(d."purchase_price")::text AS value
            FROM "devices" d
            LEFT JOIN "locations" loc ON loc."id" = d."location_id"
            WHERE d."org_id" = ${orgId}
            GROUP BY d."location_id", loc."name"
            ORDER BY loc."name" NULLS LAST
          `),

          fastify.prisma.$queryRaw<
            Array<{ costCenter: string | null; count: number; value: string | null }>
          >(Prisma.sql`
            SELECT
              "cost_center"               AS "costCenter",
              COUNT(*)::int               AS count,
              SUM("purchase_price")::text AS value
            FROM "devices"
            WHERE "org_id" = ${orgId}
            GROUP BY "cost_center"
            ORDER BY "cost_center" NULLS LAST
          `),
        ]);

      return reply.send({
        summary:      summary[0],
        byStatus,
        byType,
        byDepartment,
        byLocation,
        byCostCenter,
      });
    }
  );
}
