import nodemailer from 'nodemailer';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Mailer
// ---------------------------------------------------------------------------

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!transporter) {
    if (!config.SMTP_HOST || !config.SMTP_USER) {
      // No SMTP configured — log only
      return null;
    }
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });
  }
  return transporter;
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}) {
  const t = getTransporter();
  if (!t) {
    console.log(`[email:no-smtp] To: ${opts.to} | Subject: ${opts.subject}`);
    return;
  }
  await t.sendMail({ from: config.EMAIL_FROM, ...opts });
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export async function sendSlack(text: string) {
  if (!config.SLACK_WEBHOOK_URL) return;
  await fetch(config.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

// ---------------------------------------------------------------------------
// Domain notifications
// ---------------------------------------------------------------------------

export async function sendAssignmentAckEmail(opts: {
  assigneeEmail: string;
  assigneeName: string;
  deviceModel: string;
  deviceSerial: string;
  conditionNotes: string | null;
  ackToken: string;
}) {
  const ackUrl = `${config.APP_BASE_URL}/ack/${opts.ackToken}`;
  await sendEmail({
    to: opts.assigneeEmail,
    subject: `Please acknowledge receipt of ${opts.deviceModel}`,
    html: `
      <p>Hi ${opts.assigneeName},</p>
      <p>A device has been assigned to you:</p>
      <ul>
        <li><strong>Model:</strong> ${opts.deviceModel}</li>
        <li><strong>Serial:</strong> ${opts.deviceSerial}</li>
        ${opts.conditionNotes ? `<li><strong>Condition notes:</strong> ${opts.conditionNotes}</li>` : ''}
      </ul>
      <p>Please click the link below to acknowledge receipt:</p>
      <p><a href="${ackUrl}">${ackUrl}</a></p>
      <p>This link expires in 7 days.</p>
    `,
  });
}

export async function sendStaleDeviceAlert(opts: {
  itEmail: string;
  deviceModel: string;
  deviceSerial: string;
  lastSeen: Date | null;
  staleThresholdDays: number;
}) {
  const lastSeenStr = opts.lastSeen
    ? opts.lastSeen.toISOString()
    : 'never checked in';

  const message = `🔴 Stale device alert: ${opts.deviceModel} (${opts.deviceSerial}) has not checked in since ${lastSeenStr} (threshold: ${opts.staleThresholdDays} days)`;

  await Promise.all([
    sendEmail({
      to: opts.itEmail,
      subject: `Stale device: ${opts.deviceModel} (${opts.deviceSerial})`,
      html: `<p>${message}</p>`,
    }),
    sendSlack(message),
  ]);
}

export async function sendUnassignedDeviceAlert(opts: {
  itEmail: string;
  deviceModel: string;
  deviceSerial: string;
  unassignedSince: Date;
  thresholdDays: number;
}) {
  const message = `⚠️ Unassigned device: ${opts.deviceModel} (${opts.deviceSerial}) has been unassigned since ${opts.unassignedSince.toISOString()} (threshold: ${opts.thresholdDays} days)`;

  await Promise.all([
    sendEmail({
      to: opts.itEmail,
      subject: `Unassigned device: ${opts.deviceModel} (${opts.deviceSerial})`,
      html: `<p>${message}</p>`,
    }),
    sendSlack(message),
  ]);
}

export async function sendOffboardingAlert(opts: {
  itEmail: string;
  employeeName: string;
  devices: Array<{ model: string; serial: string }>;
}) {
  const deviceList = opts.devices
    .map((d) => `<li>${d.model} — ${d.serial}</li>`)
    .join('');

  await sendEmail({
    to: opts.itEmail,
    subject: `Offboarding: ${opts.employeeName} has assigned devices`,
    html: `
      <p>${opts.employeeName} has been offboarded. Please recover the following devices:</p>
      <ul>${deviceList}</ul>
    `,
  });
}
