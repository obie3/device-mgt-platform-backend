import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import path from 'path';
import fs from 'fs';

import prismaPlugin  from './plugins/prisma.js';
import authPlugin    from './plugins/auth.js';
import storagePlugin from './plugins/storage.js';
import emailerPlugin from './plugins/emailer.js';
import { config } from './config.js';

import authRoutes       from './routes/auth.js';
import deviceRoutes     from './routes/devices.js';
import employeeRoutes   from './routes/employees.js';
import assignmentRoutes from './routes/assignments.js';
import auditRoutes      from './routes/audit.js';
import reportRoutes     from './routes/reports.js';
import userRoutes       from './routes/users.js';
import alertRoutes      from './routes/alerts.js';
import departmentRoutes from './routes/departments.js';
import locationRoutes   from './routes/locations.js';
import approvalRoutes   from './routes/approvals.js';
import orgRoutes        from './routes/org.js';
import repairRoutes     from './routes/repairs.js';
import analyticsRoutes  from './routes/analytics.js';

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        config.NODE_ENV !== 'production'
          ? { target: 'pino-pretty' }
          : undefined,
    },
    // Explicit body size cap (default is 1MB but we set it explicitly so it's
    // not silently changed by a Fastify upgrade). Prevents memory exhaustion
    // from oversized JSON payloads.
    bodyLimit: 1_048_576, // 1 MB
  });

  // Security headers — must be registered before routes so the headers are set
  // on every response including error responses.
  await fastify.register(helmet, {
    // Content-Security-Policy is intentionally relaxed for an API-only server.
    // The frontend (served separately) sets its own CSP. We still include
    // the header to prevent downstream proxies from injecting scripts if this
    // endpoint is ever accidentally served as HTML.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // not needed for a pure API
  });

  await fastify.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  });

  // HttpOnly cookies for refresh tokens (Fix #1 — XSS hardening)
  await fastify.register(cookie);

  // Global rate limit — individual auth routes add tighter per-route limits
  // on top of this (see routes/auth.ts).
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await fastify.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  });

  // Serve uploaded device images as static files.
  // The directory is created on startup if it doesn't exist.
  const uploadDir = path.resolve(config.UPLOAD_DIR);
  fs.mkdirSync(uploadDir, { recursive: true });
  await fastify.register(staticFiles, {
    root: uploadDir,
    prefix: '/uploads/',
    // Do not index directories
    list: false,
    decorateReply: false,
  });

  await fastify.register(prismaPlugin);
  await fastify.register(storagePlugin);
  await fastify.register(emailerPlugin);
  await fastify.register(authPlugin);

  // Health check — no auth required
  fastify.get('/health', async () => ({ status: 'ok' }));

  // Routes
  const v1Prefix = { prefix: '/api/v1' };
  await fastify.register(authRoutes, v1Prefix);
  await fastify.register(userRoutes, v1Prefix);
  await fastify.register(deviceRoutes, v1Prefix);
  await fastify.register(employeeRoutes, v1Prefix);
  await fastify.register(assignmentRoutes, v1Prefix);
  await fastify.register(auditRoutes, v1Prefix);
  await fastify.register(alertRoutes,      v1Prefix);
  await fastify.register(departmentRoutes, v1Prefix);
  await fastify.register(locationRoutes,   v1Prefix);
  await fastify.register(approvalRoutes,   v1Prefix);
  await fastify.register(orgRoutes,        v1Prefix);
  await fastify.register(repairRoutes,     v1Prefix);
  await fastify.register(analyticsRoutes,  v1Prefix);
  await fastify.register(reportRoutes,     v1Prefix);

  return fastify;
}
