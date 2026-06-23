import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

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
    expiresIn: config.JWT_ACCESS_EXPIRES_IN,
  });
}

export function signRefreshToken(userId: string, jti: string) {
  return jwt.sign(
    { sub: userId, jti, type: 'refresh' },
    config.JWT_REFRESH_SECRET,
    { expiresIn: config.JWT_REFRESH_EXPIRES_IN }
  );
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.JWT_REFRESH_SECRET) as RefreshTokenPayload;
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

export async function loginUser(
  prisma: PrismaClient,
  email: string,
  password: string
) {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.isActive) {
    return null;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  // Issue tokens
  const jti = crypto.randomUUID();
  const accessToken = signAccessToken({
    sub: user.id,
    orgId: user.orgId,
    role: user.role,
  });
  const refreshToken = signRefreshToken(user.id, jti);

  // Persist hashed refresh token
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: refreshExpiresAt(),
    },
  });

  return { accessToken, refreshToken, user };
}

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

  const accessToken = signAccessToken({
    sub: user.id,
    orgId: user.orgId,
    role: user.role,
  });

  return { accessToken, user };
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
  // Cost 10: ~100ms — OWASP minimum, well below cost 12's ~400ms
  return bcrypt.hash(password, 10);
}
