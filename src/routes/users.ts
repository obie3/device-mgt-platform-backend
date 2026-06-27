import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { requireRole } from '../middleware/rbac.js';
import { hashPassword, revokeAllUserTokens } from '../services/auth.service.js';
import { logAudit } from '../services/audit.service.js';

// Password rule: 8–128 chars. Upper bound prevents bcrypt DoS (bcrypt silently
// truncates at 72 bytes but still processes the full string before truncation).
const passwordField = z.string().min(8).max(128);

const createUserBody = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  password: passwordField,
  role: z.nativeEnum(UserRole).default(UserRole.viewer),
});

const updateUserBody = z.object({
  name: z.string().min(1).max(200).optional(),
  role: z.nativeEnum(UserRole).optional(),
  isActive: z.boolean().optional(),
  password: passwordField.optional(),
});

export default async function userRoutes(fastify: FastifyInstance) {
  // GET /users restricted to operator+ — viewer role should not enumerate
  // all platform accounts in the org.
  const operatorOnly = [fastify.authenticate, requireRole('operator')];
  const adminOnly    = [fastify.authenticate, requireRole('admin')];

  // GET /api/v1/users — operator+ only
  fastify.get('/users', { preHandler: operatorOnly }, async (request, reply) => {
    const { orgId } = request.user;
    const users = await fastify.prisma.user.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send(users);
  });

  // POST /api/v1/users — admin only
  fastify.post('/users', { preHandler: adminOnly }, async (request, reply) => {
    const parsed = createUserBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { orgId, sub: actorId } = request.user;
    const { name, email, password, role } = parsed.data;

    // Check uniqueness within this org only — email may legitimately belong to
    // a user in another org (the schema now enforces @@unique([orgId, email])).
    const existing = await fastify.prisma.user.findFirst({
      where: { email, orgId },
    });
    if (existing) {
      return reply.status(409).send({ error: 'Email already in use within this organisation' });
    }

    const passwordHash = await hashPassword(password);
    const user = await fastify.prisma.user.create({
      data: { orgId, name, email, passwordHash, role },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });

    await logAudit(fastify.prisma, {
      orgId,
      userId: actorId,
      action: 'user.created',
      resourceType: 'user',
      resourceId: user.id,
    });

    return reply.status(201).send(user);
  });

  // PATCH /api/v1/users/:id — admin only
  fastify.patch(
    '/users/:id',
    { preHandler: adminOnly },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { orgId, sub: actorId } = request.user;

      const parsed = updateUserBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const target = await fastify.prisma.user.findFirst({
        where: { id, orgId },
      });
      if (!target) return reply.status(404).send({ error: 'User not found' });

      const { password, ...rest } = parsed.data;
      const data: Record<string, unknown> = { ...rest };
      if (password) {
        data.passwordHash = await hashPassword(password);
        // Revoke all sessions on password change
        await revokeAllUserTokens(fastify.prisma, id);
      }

      if (rest.isActive === false) {
        await revokeAllUserTokens(fastify.prisma, id);
      }

      const updated = await fastify.prisma.user.update({
        where: { id },
        data,
        select: { id: true, name: true, email: true, role: true, isActive: true },
      });

      await logAudit(fastify.prisma, {
        orgId,
        userId: actorId,
        action: 'user.updated',
        resourceType: 'user',
        resourceId: id,
        payload: rest,
      });

      return reply.send(updated);
    }
  );
}
