import { FastifyInstance } from 'fastify';
import { requireRole }     from '../middleware/rbac.js';

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/trends
//
// Returns two series for the Dashboard:
//   - deviceGrowth:   devices added per calendar month for the last 12 months
//   - warrantyExpiry: devices with warrantyEnd in each of the next 90 days
//                     (bucketed by month for readability)
// ---------------------------------------------------------------------------

export default async function analyticsRoutes(fastify: FastifyInstance) {
  const auth = [fastify.authenticate, requireRole('operator')];

  fastify.get('/analytics/trends', { preHandler: auth }, async (request, reply) => {
    const { orgId } = request.user;

    // ── Device growth: last 12 months ──────────────────────────────────────
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const growthRaw = await fastify.prisma.$queryRawUnsafe<
      { month: string; count: bigint }[]
    >(
      `SELECT
         to_char(created_at, 'YYYY-MM') AS month,
         COUNT(*)                        AS count
       FROM devices
       WHERE org_id = $1
         AND created_at >= $2
       GROUP BY month
       ORDER BY month ASC`,
      orgId,
      twelveMonthsAgo,
    );

    // Fill gaps — ensure all 12 months are present even if count = 0
    const growthMap = new Map(growthRaw.map(r => [r.month, Number(r.count)]));
    const deviceGrowth: { month: string; count: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      deviceGrowth.push({ month: label, count: growthMap.get(label) ?? 0 });
    }

    // ── Warranty expiry: next 90 days, bucketed by month ──────────────────
    const now     = new Date();
    const in90    = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

    const expiryRaw = await fastify.prisma.$queryRawUnsafe<
      { month: string; count: bigint }[]
    >(
      `SELECT
         to_char(warranty_end, 'YYYY-MM') AS month,
         COUNT(*)                          AS count
       FROM devices
       WHERE org_id = $1
         AND warranty_end IS NOT NULL
         AND warranty_end >= $2
         AND warranty_end <= $3
         AND status != 'decommissioned'
       GROUP BY month
       ORDER BY month ASC`,
      orgId,
      now,
      in90,
    );

    const warrantyExpiry = expiryRaw.map(r => ({
      month: r.month,
      count: Number(r.count),
    }));

    return reply.send({ deviceGrowth, warrantyExpiry });
  });
}
