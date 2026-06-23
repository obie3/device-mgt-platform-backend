import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';

import prismaPlugin from './plugins/prisma.js';
import authPlugin from './plugins/auth.js';
import { config } from './config.js';

import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import employeeRoutes from './routes/employees.js';
import assignmentRoutes from './routes/assignments.js';
import auditRoutes from './routes/audit.js';
import reportRoutes from './routes/reports.js';
import userRoutes from './routes/users.js';

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      transport:
        config.NODE_ENV !== 'production'
          ? { target: 'pino-pretty' }
          : undefined,
    },
  });

  // Plugins
  await fastify.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
  });

  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await fastify.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  });

  await fastify.register(prismaPlugin);
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
  await fastify.register(reportRoutes, v1Prefix);

  return fastify;
}
