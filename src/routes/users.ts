import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { requireRole } from '../middleware/rbac.js';
import { hashPassword, revokeAllUserTokens } from '../services/auth.service.js';
import { logAudit } from '../services/audit.service.js';

const createUserBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.nativeEnum(UserRole).default(UserRole.viewer),
});

const updateUserBody = z.object({
  name: z.string().min(1).optional(),
  role: z.nativeEnum(UserRole).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

export default async function userRoutes(fastify: FastifyInstance) {
  const auth = [fastify.authenticate];
  const adminOnly = [fastify.authenticate, requireRole('admin')];

  // GET /api/v1/users
  fastify.get('/users', { preHandler: auth }, async (request, reply) => {
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

    const existing = await fastify.prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.status(409).send({ error: 'Email already in use' });
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
