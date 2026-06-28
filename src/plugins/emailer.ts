import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { createEmailProvider } from '../services/email/index.js';
import type { EmailProvider }  from '../services/email/index.js';
import { config }              from '../config.js';

// Augment FastifyInstance so routes get full type-safety on fastify.emailer
declare module 'fastify' {
  interface FastifyInstance {
    /** null when SMTP is not configured — treat as "email unavailable" */
    emailer: EmailProvider | null;
  }
}

/**
 * Registers the configured EmailProvider as `fastify.emailer`.
 * Decorated value is null when SMTP_HOST / SMTP_USER env vars are absent —
 * routes should log and continue rather than failing hard in that case.
 */
const emailerPlugin: FastifyPluginAsync = async (fastify) => {
  const provider = createEmailProvider(config);
  fastify.decorate('emailer', provider);
  fastify.log.info(`[emailer] smtp: ${provider ? `${config.SMTP_HOST}:${config.SMTP_PORT}` : 'not configured'}`);
};

export default fp(emailerPlugin, { name: 'emailer' });
