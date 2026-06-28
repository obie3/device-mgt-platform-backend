import type { Config } from '../../config.js';
import type { EmailProvider } from './types.js';
import { NodemailerProvider } from './nodemailer.provider.js';

export type { EmailProvider };
export type { EmailMessage } from './types.js';

/**
 * Factory: creates the appropriate email provider from config.
 *
 * Returns `null` when SMTP credentials are not configured — callers should
 * treat null as "email unavailable" and fall back to console logging.
 *
 * Currently always returns NodemailerProvider (SMTP).  To add a transactional
 * API (Zoho Transactional API, SendGrid, Resend, etc.) in future, extend the
 * switch on an `EMAIL_PROVIDER` env var following the same pattern used in the
 * storage factory.
 */
export function createEmailProvider(config: Config): EmailProvider | null {
  if (!config.SMTP_HOST || !config.SMTP_USER) {
    return null;
  }

  return new NodemailerProvider({
    host:   config.SMTP_HOST,
    port:   config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    user:   config.SMTP_USER,
    pass:   config.SMTP_PASS ?? '',
    from:   config.EMAIL_FROM,
  });
}
