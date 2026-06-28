import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // In production, CORS_ORIGIN must be an explicit https:// domain — not a
  // wildcard or localhost. This prevents accidental misconfiguration.
  CORS_ORIGIN: z.string().default('http://localhost:3000').superRefine((val, ctx) => {
    if (process.env.NODE_ENV !== 'production') return;
    if (val === '*' || val.includes('localhost') || val.startsWith('http://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'CORS_ORIGIN must be an explicit https:// domain in production (not localhost, http://, or *).',
      });
    }
  }),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.string().transform((v) => v === 'true').default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('DMP <no-reply@example.com>'),

  APP_BASE_URL: z.string().default('http://localhost:3000'),

  // Directory where device images are stored. Must be writable by the API process.
  // In Docker this should be a mounted volume so images survive container restarts.
  UPLOAD_DIR: z.string().default('./uploads/device-images'),

  SLACK_WEBHOOK_URL: z.string().optional(),

  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ORG_NAME: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
