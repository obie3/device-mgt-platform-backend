import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';

export default async function orgRoutes(fastify: FastifyInstance) {
  // Standard RBAC pattern — consistent with every other route in the app
  const adminOnly = [fastify.authenticate, requireRole('admin')];

  // ── GET /api/v1/org ────────────────────────────────────────────────────────
  fastify.get('/org', { preHandler: adminOnly }, async (request, reply) => {
    const { orgId } = request.user;

    const org = await fastify.prisma.organization.findUnique({
      where:  { id: orgId },
      select: { id: true, name: true, unassignedAlertDays: true, settings: true, createdAt: true },
    });

    if (!org) return reply.status(404).send({ error: 'Organization not found' });

    return reply.send(org);
  });

  // ── PATCH /api/v1/org ──────────────────────────────────────────────────────
  const updateOrgBody = z.object({
    name:                z.string().min(1).max(200).optional(),
    unassignedAlertDays: z.number().int().min(1).max(365).optional(),
    slackWebhookUrl:     z.string().url().max(500).or(z.literal('')).optional(),
  });

  fastify.patch('/org', { preHandler: adminOnly }, async (request, reply) => {
    const { orgId, sub: userId } = request.user;

    const parsed = updateOrgBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { name, unassignedAlertDays, slackWebhookUrl } = parsed.data;

    // Merge slackWebhookUrl into the settings JSON blob
    const existing = await fastify.prisma.organization.findUnique({
      where:  { id: orgId },
      select: { settings: true },
    });
    if (!existing) return reply.status(404).send({ error: 'Organization not found' });

    const currentSettings = (existing.settings as Record<string, unknown>) ?? {};
    const newSettings =
      slackWebhookUrl !== undefined
        ? { ...currentSettings, slackWebhookUrl: slackWebhookUrl || null }
        : currentSettings;

    const updated = await fastify.prisma.organization.update({
      where: { id: orgId },
      data: {
        ...(name                !== undefined && { name }),
        ...(unassignedAlertDays !== undefined && { unassignedAlertDays }),
        settings: newSettings as Parameters<typeof fastify.prisma.organization.update>[0]['data']['settings'],
      },
      select: { id: true, name: true, unassignedAlertDays: true, settings: true, createdAt: true },
    });

    await logAudit(fastify.prisma, {
      orgId,
      userId,
      action:       'org.settings_updated',
      resourceType: 'organization',
      resourceId:   orgId,
      payload:      { fields: Object.keys(parsed.data) },
    });

    return reply.send(updated);
  });
}
