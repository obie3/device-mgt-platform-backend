import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  loginUser,
  refreshAccessToken,
  revokeRefreshToken,
  requestPasswordReset,
  resetPassword,
  hashPassword,
  revokeAllUserTokens,
} from '../services/auth.service.js';
import { sendPasswordResetEmail } from '../services/notification.service.js';
import { logAudit } from '../services/audit.service.js';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

// ─── Shared password rule (8–128 chars) applied everywhere a password is set ─

const passwordField = z.string().min(8).max(128);

const loginBody = z.object({
  email:    z.string().email(),
  password: z.string().min(1).max(128),
});

const forgotPasswordBody = z.object({
  email: z.string().email(),
});

const resetPasswordBody = z.object({
  token:    z.string().min(1),
  password: passwordField,
});

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const REFRESH_COOKIE = 'dmp_rt';
const REFRESH_TTL_S  = 7 * 24 * 60 * 60; // 7 days in seconds

function setRefreshCookie(reply: Parameters<typeof reply.setCookie>[2] extends object ? any : any, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure:   config.NODE_ENV === 'production',
    sameSite: config.NODE_ENV === 'production' ? 'none' : 'lax',
    path:     '/',
    maxAge:   REFRESH_TTL_S,
  });
}

function clearRefreshCookie(reply: any) {
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure:   config.NODE_ENV === 'production',
    sameSite: config.NODE_ENV === 'production' ? 'none' : 'lax',
    path:     '/',
  });
}

// ---------------------------------------------------------------------------

export default async function authRoutes(fastify: FastifyInstance) {
  // POST /api/v1/auth/login
  fastify.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request body' });
      }

      const result = await loginUser(
        fastify.prisma,
        parsed.data.email,
        parsed.data.password,
      );

      // Account locked
      if (result && result.status === 'locked') {
        return reply.status(423).send({
          error: 'Account temporarily locked due to too many failed login attempts.',
          lockedUntil: result.lockedUntil,
        });
      }

      // Invalid credentials
      if (!result) {
        fastify.log.warn({ email: parsed.data.email, ip: request.ip }, 'Failed login attempt');
        return reply.status(401).send({ error: 'Invalid email or password' });
      }

      const { accessToken, refreshToken, user } = result;

      // Set refresh token in HttpOnly cookie — never exposed to JS
      setRefreshCookie(reply, refreshToken);

      await logAudit(fastify.prisma, {
        orgId:        user!.orgId,
        userId:       user!.id,
        action:       'user.login',
        resourceType: 'user',
        resourceId:   user!.id,
        payload:      { ip: request.ip },
      });

      return reply.send({
        accessToken,
        user: {
          id:    user!.id,
          name:  user!.name,
          email: user!.email,
          role:  user!.role,
          orgId: user!.orgId,
        },
      });
    }
  );

  // POST /api/v1/auth/refresh
  // Reads the refresh token from the HttpOnly cookie (set at login).
  fastify.post('/auth/refresh', async (request, reply) => {
    const token = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    if (!token) {
      return reply.status(401).send({ error: 'No refresh token' });
    }

    const result = await refreshAccessToken(fastify.prisma, token);

    if (!result) {
      clearRefreshCookie(reply);
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }

    // Rotate: issue new cookie with the rotated refresh token
    setRefreshCookie(reply, result.refreshToken);

    return reply.send({ accessToken: result.accessToken });
  });

  // POST /api/v1/auth/logout
  fastify.post(
    '/auth/logout',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const token = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
      if (token) {
        await revokeRefreshToken(fastify.prisma, token);
      }
      clearRefreshCookie(reply);
      return reply.status(204).send();
    }
  );

  // POST /api/v1/auth/forgot-password
  fastify.post(
    '/auth/forgot-password',
    { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = forgotPasswordBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request body' });
      }

      const result = await requestPasswordReset(fastify.prisma, parsed.data.email);
      if (result) {
        sendPasswordResetEmail({
          toEmail:    result.user.email,
          resetToken: result.plainToken,
        }).catch((err) => fastify.log.error({ err }, 'Failed to send password reset email'));

        await logAudit(fastify.prisma, {
          orgId:        result.user.orgId,
          userId:       result.user.id,
          action:       'user.password_reset_requested',
          resourceType: 'user',
          resourceId:   result.user.id,
          payload:      { ip: request.ip },
        });
      }

      return reply.send({
        ok:      true,
        message: 'If that email is registered, a reset link has been sent.',
      });
    }
  );

  // POST /api/v1/auth/reset-password
  fastify.post(
    '/auth/reset-password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = resetPasswordBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const success = await resetPassword(
        fastify.prisma,
        parsed.data.token,
        parsed.data.password,
      );

      if (!success) {
        return reply.status(400).send({ error: 'Invalid or expired reset token' });
      }

      return reply.send({ ok: true });
    }
  );

  // GET /api/v1/auth/me
  fastify.get(
    '/auth/me',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const user = await fastify.prisma.user.findFirst({
        where:  { id: request.user.sub },
        select: { id: true, name: true, email: true, role: true, orgId: true, isActive: true, createdAt: true },
      });
      if (!user) return reply.status(404).send({ error: 'User not found' });
      return reply.send(user);
    }
  );

  // PATCH /api/v1/auth/me
  const updateMeBody = z.object({
    name:  z.string().min(1).max(200).optional(),
    email: z.string().email().max(320).optional(),
  }).refine((d) => d.name !== undefined || d.email !== undefined, {
    message: 'At least one field (name or email) must be provided',
  });

  fastify.patch(
    '/auth/me',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { sub: userId, orgId } = request.user;
      const parsed = updateMeBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      if (parsed.data.email) {
        const existing = await fastify.prisma.user.findFirst({
          where: { orgId, email: parsed.data.email, NOT: { id: userId } },
        });
        if (existing) return reply.status(409).send({ error: 'Email already in use' });
      }

      const updated = await fastify.prisma.user.update({
        where:  { id: userId },
        data:   parsed.data,
        select: { id: true, name: true, email: true, role: true, orgId: true, isActive: true, createdAt: true },
      });

      await logAudit(fastify.prisma, {
        orgId, userId,
        action:       'user.updated_profile',
        resourceType: 'user',
        resourceId:   userId,
        payload:      { fields: Object.keys(parsed.data) },
      });

      return reply.send(updated);
    }
  );

  // POST /api/v1/auth/change-password
  const changePasswordBody = z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword:     passwordField,
  });

  fastify.post(
    '/auth/change-password',
    { preHandler: [fastify.authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { sub: userId, orgId } = request.user;
      const parsed = changePasswordBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });

      const user = await fastify.prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.status(404).send({ error: 'User not found' });

      const valid = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
      if (!valid) return reply.status(400).send({ error: 'Current password is incorrect' });

      if (parsed.data.currentPassword === parsed.data.newPassword) {
        return reply.status(400).send({ error: 'New password must differ from current password' });
      }

      const passwordHash = await hashPassword(parsed.data.newPassword);
      await fastify.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
      await revokeAllUserTokens(fastify.prisma, userId);

      // Clear the refresh cookie on this device too
      clearRefreshCookie(reply);

      await logAudit(fastify.prisma, {
        orgId, userId,
        action:       'user.changed_password',
        resourceType: 'user',
        resourceId:   userId,
        payload:      {},
      });

      return reply.send({ ok: true });
    }
  );
}
