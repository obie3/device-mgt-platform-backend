import { createEmailProvider } from './email/index.js';
import type { EmailProvider }  from './email/index.js';
import { config }              from '../config.js';

// ---------------------------------------------------------------------------
// Emailer — module-level singleton
// ---------------------------------------------------------------------------
// Initialised once at module load.  null when SMTP is not configured — all
// sendEmail calls below log and return rather than throwing.

const emailer: EmailProvider | null = createEmailProvider(config);

async function sendEmail(opts: { to: string; subject: string; html: string }) {
  if (!emailer) {
    console.log(`[email:no-smtp] To: ${opts.to} | Subject: ${opts.subject}`);
    return;
  }
  await emailer.send({ to: opts.to, subject: opts.subject, html: opts.html });
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

// webhookUrl: per-org webhook stored in org.settings.slackWebhookUrl; falls
// back to the global env-var webhook so both can coexist.
export async function sendSlack(text: string, webhookUrl?: string | null) {
  const url = webhookUrl || config.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('[slack] Failed to send notification:', err);
  }
}

// ---------------------------------------------------------------------------
// Domain notifications
// ---------------------------------------------------------------------------

export async function sendAssignmentAckEmail(opts: {
  assigneeEmail:  string;
  assigneeName:   string;
  deviceModel:    string;
  deviceSerial:   string;
  conditionNotes: string | null;
  ackToken:       string;
}) {
  const ackUrl = `${config.APP_BASE_URL}/ack/${opts.ackToken}`;
  await sendEmail({
    to:      opts.assigneeEmail,
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

export async function sendUnassignedDeviceAlert(opts: {
  itEmail:         string;
  deviceModel:     string;
  deviceSerial:    string;
  unassignedSince: Date;
  thresholdDays:   number;
}) {
  const message = `⚠️ Unassigned device: ${opts.deviceModel} (${opts.deviceSerial}) has been unassigned since ${opts.unassignedSince.toISOString()} (threshold: ${opts.thresholdDays} days)`;

  await Promise.all([
    sendEmail({
      to:      opts.itEmail,
      subject: `Unassigned device: ${opts.deviceModel} (${opts.deviceSerial})`,
      html:    `<p>${message}</p>`,
    }),
    sendSlack(message),
  ]);
}

export async function sendWarrantyExpiryAlert(opts: {
  itEmail:      string;
  deviceModel:  string;
  deviceSerial: string;
  warrantyEnd:  Date;
  isExpired:    boolean;
}) {
  const dateStr = opts.warrantyEnd.toISOString().slice(0, 10);
  const subject = opts.isExpired
    ? `Warranty expired: ${opts.deviceModel} (${opts.deviceSerial})`
    : `Warranty expiring soon: ${opts.deviceModel} (${opts.deviceSerial})`;
  const body = opts.isExpired
    ? `⚠️ Warranty expired: ${opts.deviceModel} (${opts.deviceSerial}) — warranty ended on ${dateStr}. Consider renewing or planning for replacement.`
    : `⏰ Warranty expiring soon: ${opts.deviceModel} (${opts.deviceSerial}) — warranty ends on ${dateStr}. Take action before coverage lapses.`;

  await Promise.all([
    sendEmail({ to: opts.itEmail, subject, html: `<p>${body}</p>` }),
    sendSlack(body),
  ]);
}

export async function sendPasswordResetEmail(opts: {
  toEmail:    string;
  resetToken: string;
}) {
  const resetUrl = `${config.APP_BASE_URL}/reset-password/${opts.resetToken}`;
  await sendEmail({
    to:      opts.toEmail,
    subject: 'Reset your password',
    html: `
      <p>We received a request to reset your password.</p>
      <p>Click the link below to choose a new one:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>
    `,
  });
}

export async function sendApprovalRequestedEmail(opts: {
  adminEmails:   string[];
  requesterName: string;
  type:          'assignment' | 'decommission' | 'offboard';
  deviceModel?:  string;
  deviceSerial?: string;
  employeeName?: string;
}) {
  const actionLabel =
    opts.type === 'assignment'
      ? `assign device ${opts.deviceModel} (${opts.deviceSerial}) to ${opts.employeeName}`
      : opts.type === 'decommission'
      ? `decommission device ${opts.deviceModel} (${opts.deviceSerial})`
      : `offboard employee ${opts.employeeName}`;

  const subject = `Approval needed: ${opts.requesterName} wants to ${actionLabel}`;
  const html = `
    <p><strong>${opts.requesterName}</strong> has submitted a request to ${actionLabel}.</p>
    <p>Please log in to the Device Management Platform to approve or reject this request.</p>
  `;

  await Promise.all(
    opts.adminEmails.map((email) => sendEmail({ to: email, subject, html }))
  );
  await sendSlack(`⏳ Approval needed: ${opts.requesterName} wants to ${actionLabel}`);
}

export async function sendApprovalResolvedEmail(opts: {
  requesterEmail: string;
  requesterName:  string;
  type:           'assignment' | 'decommission' | 'offboard';
  approved:       boolean;
  deviceModel?:   string;
  deviceSerial?:  string;
  employeeName?:  string;
  reviewNote?:    string;
}) {
  const actionLabel =
    opts.type === 'assignment'
      ? `assign device ${opts.deviceModel} (${opts.deviceSerial})`
      : opts.type === 'decommission'
      ? `decommission device ${opts.deviceModel} (${opts.deviceSerial})`
      : `offboard employee ${opts.employeeName}`;

  const verdict = opts.approved ? 'approved ✅' : 'rejected ❌';
  const subject = `Your request to ${actionLabel} was ${opts.approved ? 'approved' : 'rejected'}`;
  const html = `
    <p>Hi ${opts.requesterName},</p>
    <p>Your request to <strong>${actionLabel}</strong> has been <strong>${verdict}</strong>.</p>
    ${opts.reviewNote ? `<p><strong>Note:</strong> ${opts.reviewNote}</p>` : ''}
    <p>Please log in to the Device Management Platform for more details.</p>
  `;

  await sendEmail({ to: opts.requesterEmail, subject, html });
}

export async function sendOffboardingAlert(opts: {
  itEmail:      string;
  employeeName: string;
  devices:      Array<{ model: string; serial: string }>;
}) {
  const deviceList = opts.devices
    .map((d) => `<li>${d.model} — ${d.serial}</li>`)
    .join('');

  await sendEmail({
    to:      opts.itEmail,
    subject: `Offboarding: ${opts.employeeName} has assigned devices`,
    html: `
      <p>${opts.employeeName} has been offboarded. Please recover the following devices:</p>
      <ul>${deviceList}</ul>
    `,
  });
}
