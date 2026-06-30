import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { logAudit } from './audit.service.js';

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  role: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  type: 'refresh';
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>) {
  return jwt.sign({ ...payload, type: 'access' }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: config.JWT_ACCESS_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function signRefreshToken(userId: string, jti: string) {
  return jwt.sign(
    { sub: userId, jti, type: 'refresh' },
    config.JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: config.JWT_REFRESH_EXPIRES_IN } as jwt.SignOptions
  );
}

/**
 * Verifies a refresh token JWT. Throws if invalid signature or expired.
 * Also validates the `type` claim at runtime — a cast alone is insufficient
 * because if both secrets were accidentally identical an access token could
 * pass signature verification.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, config.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  if (payload.type !== 'refresh') {
    throw new Error('Token type mismatch: expected refresh');
  }
  return payload;
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiresAt(): Date {
  // Parse e.g. "7d" → ms
  const str = config.JWT_REFRESH_EXPIRES_IN;
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) throw new Error('Invalid JWT_REFRESH_EXPIRES_IN format');
  const num = parseInt(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return new Date(Date.now() + num * multipliers[unit]);
}

// ---------------------------------------------------------------------------
// Auth operations
// ---------------------------------------------------------------------------

const MAX_FAILED_ATTEMPTS = 5;          // lock after 5 consecutive failures
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30-minute lockout window

export type LoginResult =
  | { status: 'ok'; accessToken: string; refreshToken: string; user: Awaited<ReturnType<PrismaClient['user']['findFirst']>> & object }
  | { status: 'locked'; lockedUntil: Date; userId: string; orgId: string }
  | null; // invalid credentials (user not found)

export async function loginUser(
  prisma: PrismaClient,
  email: string,
  password: string
): Promise<LoginResult> {
  // Normalise before lookup — prevents case-variant bypass of lockout counters
  const emailNorm = email.toLowerCase().trim();
  const user = await prisma.user.findFirst({
    where: { email: emailNorm, isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  // Unknown email — return null without leaking whether the account exists
  if (!user) return null;

  // Account lockout check
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { status: 'locked', lockedUntil: user.lockedUntil, userId: user.id, orgId: user.orgId };
  }

  const valid = await bcrypt.compare(password, user.passwordHash);

  if (!valid) {
    const newAttempts = user.failedLoginAttempts + 1;
    const shouldLock  = newAttempts >= MAX_FAILED_ATTEMPTS;
    const lockedUntil = shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : undefined;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: newAttempts, lockedUntil },
    });
    if (shouldLock) {
      // Log lockout — security-relevant event indicating a brute-force attempt
      await logAudit(prisma, {
        orgId:        user.orgId,
        userId:       user.id,
        action:       'user.account_locked',
        resourceType: 'user',
        resourceId:   user.id,
        payload:      { attempts: newAttempts, lockedUntil },
      }).catch(() => {});  // non-fatal — don't let audit failure block the response
    }
    // Return null (not 'locked') so the caller emits the same generic error
    // message — the lock takes effect on the NEXT attempt.
    return null;
  }

  // Successful login — reset failure counters
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null },
  });

  // Issue tokens
  const jti = crypto.randomUUID();
  const accessToken  = signAccessToken({ sub: user.id, orgId: user.orgId, role: user.role });
  const refreshToken = signRefreshToken(user.id, jti);

  await prisma.refreshToken.create({
    data: {
      userId:    user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiresAt(),
    },
  });

  return { status: 'ok', accessToken, refreshToken, user };
}

/**
 * Rotates the refresh token on every use:
 * - Old token is revoked immediately
 * - New refresh token is issued and persisted
 * Returns both new access and refresh tokens.
 * This makes stolen refresh tokens detectable: the legitimate holder's next
 * refresh will fail because the token was already rotated by the attacker.
 */
export async function refreshAccessToken(
  prisma: PrismaClient,
  refreshToken: string
) {
  let payload: RefreshTokenPayload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    return null;
  }

  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    return null;
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || !user.isActive) return null;

  // Rotate: revoke old token, issue new one in a transaction
  const newJti = crypto.randomUUID();
  const newRefreshToken = signRefreshToken(user.id, newJti);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(newRefreshToken),
        expiresAt: refreshExpiresAt(),
      },
    }),
  ]);

  const accessToken = signAccessToken({
    sub: user.id,
    orgId: user.orgId,
    role: user.role,
  });

  return { accessToken, refreshToken: newRefreshToken, user };
}

export async function revokeRefreshToken(
  prisma: PrismaClient,
  refreshToken: string
) {
  const tokenHash = hashToken(refreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Revoke all tokens for a user (e.g. on password change or account deactivation)
export async function revokeAllUserTokens(
  prisma: PrismaClient,
  userId: string
) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function hashPassword(password: string) {
  // Cost 12: ~250ms — current OWASP recommendation (2024+)
  return bcrypt.hash(password, 12);
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function requestPasswordReset(prisma: PrismaClient, email: string) {
  const emailNorm = email.toLowerCase().trim();
  const user = await prisma.user.findFirst({
    where: { email: emailNorm, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) return null;

  const plainToken = crypto.randomBytes(32).toString('hex');

  // Revoke all outstanding reset tokens before issuing a new one.
  // Prevents an attacker from using an intercepted older token after
  // the user has already requested a fresh one.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(plainToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    }),
  ]);

  return { user, plainToken };
}

export async function resetPassword(
  prisma: PrismaClient,
  plainToken: string,
  newPassword: string
) {
  const tokenHash = hashToken(plainToken);
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (
    !resetToken ||
    resetToken.usedAt ||
    resetToken.expiresAt < new Date()
  ) {
    return false;
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    }),
  ]);

  // Invalidate existing sessions on password change
  await revokeAllUserTokens(prisma, resetToken.userId);

  return true;
}
