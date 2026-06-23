import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  loginUser,
  refreshAccessToken,
  revokeRefreshToken,
} from '../services/auth.service.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshBody = z.object({
  refreshToken: z.string(),
});

export default async function authRoutes(fastify: FastifyInstance) {
  // POST /api/v1/auth/login
  fastify.post('/auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const result = await loginUser(
      fastify.prisma,
      parsed.data.email,
      parsed.data.password
    );

    if (!result) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    const { accessToken, refreshToken, user } = result;

    return reply.send({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        orgId: user.orgId,
      },
    });
  });

  // POST /api/v1/auth/refresh
  fastify.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const result = await refreshAccessToken(
      fastify.prisma,
      parsed.data.refreshToken
    );

    if (!result) {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }

    return reply.send({ accessToken: result.accessToken });
  });

  // POST /api/v1/auth/logout
  fastify.post(
    '/auth/logout',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = refreshBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request body' });
      }

      await revokeRefreshToken(fastify.prisma, parsed.data.refreshToken);

      return reply.status(204).send();
    }
  );

  // GET /api/v1/auth/me
  fastify.get(
    '/auth/me',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = await fastify.prisma.user.findUnique({
        where: { id: request.user.sub },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          orgId: true,
          isActive: true,
          createdAt: true,
        },
      });

      if (!user) return reply.status(404).send({ error: 'User not found' });

      return reply.send(user);
    }
  );
}
