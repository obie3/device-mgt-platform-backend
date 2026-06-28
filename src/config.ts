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

  // ---------------------------------------------------------------------------
  // Storage provider
  // ---------------------------------------------------------------------------
  // 'local'       — write files to UPLOAD_DIR (default, dev-friendly)
  // 's3'          — AWS S3 or any S3-compatible store (R2, MinIO)
  // 'cloudinary'  — Cloudinary media platform
  STORAGE_PROVIDER: z.enum(['local', 's3', 'cloudinary']).default('local'),

  // Directory where device images are stored (local provider only).
  // Must be writable by the API process. In Docker, mount this as a named
  // volume so images survive container restarts.
  UPLOAD_DIR: z.string().default('./uploads/device-images'),

  // S3 / S3-compatible (required when STORAGE_PROVIDER=s3)
  S3_BUCKET:            z.string().optional(),
  S3_REGION:            z.string().optional(),
  S3_ACCESS_KEY_ID:     z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Custom endpoint for Cloudflare R2 / MinIO (omit for standard AWS) */
  S3_ENDPOINT:          z.string().optional(),
  /** Base URL for public object access — no trailing slash.
   *  AWS:     https://<bucket>.s3.<region>.amazonaws.com
   *  R2/CDN:  https://cdn.example.com */
  S3_PUBLIC_BASE_URL:   z.string().optional(),

  // Cloudinary (required when STORAGE_PROVIDER=cloudinary)
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY:    z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

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
