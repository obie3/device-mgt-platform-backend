import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailProvider, EmailMessage } from './types.js';

export interface SmtpConfig {
  host:   string;
  port:   number;
  /** true for port 465 (SSL), false for port 587 (STARTTLS) */
  secure: boolean;
  user:   string;
  pass:   string;
  /** Full "From" header, e.g. `"DMP <no-reply@yourdomain.com>"` */
  from:   string;
}

/**
 * SMTP email provider backed by Nodemailer.
 *
 * Works out of the box with ZohoMail:
 *   SMTP_HOST=smtp.zoho.com
 *   SMTP_PORT=587
 *   SMTP_SECURE=false      (STARTTLS on 587)
 *   SMTP_USER=no-reply@yourdomain.com
 *   SMTP_PASS=<app-password>   ← generate in Zoho → Security → App Passwords
 *   EMAIL_FROM="DMP <no-reply@yourdomain.com>"
 *
 * ZohoMail requires:
 *   1. A verified sending domain in Zoho Mail Admin.
 *   2. An App Password (not your account password) when 2FA is enabled.
 *
 * Also works with any standard SMTP server (Gmail relay, SES SMTP, SendGrid
 * legacy SMTP, etc.) by adjusting the host/port/credentials.
 */
export class NodemailerProvider implements EmailProvider {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(cfg: SmtpConfig) {
    this.from = cfg.from;
    this.transporter = nodemailer.createTransport({
      host:   cfg.host,
      port:   cfg.port,
      secure: cfg.secure,
      auth:   { user: cfg.user, pass: cfg.pass },
      // Fail fast — prevents an unreachable SMTP server from hanging the
      // request for the OS-default 20s TCP timeout.
      connectionTimeout: 5_000,
      greetingTimeout:   5_000,
      socketTimeout:     10_000,
    });
  }

  async send({ to, subject, html, text, replyTo, cc }: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to,
      cc,
      replyTo,
      subject,
      html,
      // Strip HTML tags for a basic plain-text fallback if not provided
      text: text ?? html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim(),
    });
  }
}
