import { FastifyInstance } from 'fastify';
import { requireRole }     from '../middleware/rbac.js';

export default async function analyticsRoutes(fastify: FastifyInstance) {
  const auth = [fastify.authenticate, requireRole('operator')];

  fastify.get('/analytics/trends', { preHandler: auth }, async (request, reply) => {
    const { orgId } = request.user;

    // ── Device growth: last 12 months ──────────────────────────────────────
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    // $queryRaw with tagged template — Prisma statically enforces parameterisation,
    // preventing any future accidental string interpolation (Fix #4).
    const growthRaw = await fastify.prisma.$queryRaw<{ month: string; count: bigint }[]>`
      SELECT
        to_char(created_at, 'YYYY-MM') AS month,
        COUNT(*)::bigint                AS count
      FROM devices
      WHERE org_id   = ${orgId}
        AND created_at >= ${twelveMonthsAgo}
      GROUP BY month
      ORDER BY month ASC
    `;

    const growthMap = new Map(growthRaw.map(r => [r.month, Number(r.count)]));
    const deviceGrowth: { month: string; count: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      deviceGrowth.push({ month: label, count: growthMap.get(label) ?? 0 });
    }

    // ── Warranty expiry: next 90 days, bucketed by month ──────────────────
    const now  = new Date();
    const in90 = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const expiryRaw = await fastify.prisma.$queryRaw<{ month: string; count: bigint }[]>`
      SELECT
        to_char(warranty_end, 'YYYY-MM') AS month,
        COUNT(*)::bigint                  AS count
      FROM devices
      WHERE org_id       = ${orgId}
        AND warranty_end IS NOT NULL
        AND warranty_end >= ${now}
        AND warranty_end <= ${in90}
        AND status       != 'decommissioned'
      GROUP BY month
      ORDER BY month ASC
    `;

    const warrantyExpiry = expiryRaw.map(r => ({
      month: r.month,
      count: Number(r.count),
    }));

    return reply.send({ deviceGrowth, warrantyExpiry });
  });
}
