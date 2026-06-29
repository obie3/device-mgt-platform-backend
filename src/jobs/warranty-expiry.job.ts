import { PrismaClient } from '@prisma/client';
import { sendWarrantyExpiryAlert, sendSlack } from '../services/notification.service.js';

// Alert window: devices whose warranty ends within this many days get flagged.
// Also catches devices whose warranty has already expired (warrantyEnd <= now).
const WARRANTY_ALERT_DAYS = 30;

export async function runWarrantyExpiryJob(prisma: PrismaClient) {
  console.log('[job:warranty-expiry] starting');

  const alertWindow = new Date(Date.now() + WARRANTY_ALERT_DAYS * 24 * 60 * 60 * 1000);

  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      settings: true,
      users: {
        where: { role: 'admin', isActive: true },
        select: { email: true },
        take: 1,
      },
    },
  });

  let alertsSent = 0;

  for (const org of orgs) {
    // Devices with warranty ending within the alert window, no open warranty_expiry
    // alert, and not decommissioned (no point alerting on retired hardware).
    const candidates = await prisma.device.findMany({
      where: {
        orgId: org.id,
        warrantyEnd: { lte: alertWindow, not: null },
        status: { not: 'decommissioned' as never },
        // Cast required until `npx prisma generate` is run with the new AlertType migration.
        alerts: {
          none: { type: 'warranty_expiry' as never, resolvedAt: null },
        },
      },
      select: {
        id: true,
        model: true,
        serial: true,
        warrantyEnd: true,
      },
    });

    const itEmail = org.users[0]?.email;
    const orgSlack = (org.settings as Record<string, unknown>)?.slackWebhookUrl as string | undefined;

    for (const device of candidates) {
      const warrantyEnd = device.warrantyEnd!; // guaranteed non-null by the query filter
      const isExpired = warrantyEnd < new Date();
      const dateStr = warrantyEnd.toISOString().slice(0, 10);

      const message = isExpired
        ? `Warranty expired on ${dateStr}: ${device.model} (${device.serial})`
        : `Warranty expiring on ${dateStr}: ${device.model} (${device.serial})`;

      await prisma.alert.create({
        data: {
          deviceId: device.id,
          type: 'warranty_expiry' as never, // cast until prisma generate is run
          message,
        },
      });

      if (itEmail) {
        await sendWarrantyExpiryAlert({
          itEmail,
          deviceModel:  device.model,
          deviceSerial: device.serial,
          warrantyEnd,
          isExpired,
        });
      }

      await sendSlack(`🔔 ${message}`, orgSlack);

      alertsSent++;
    }
  }

  console.log(`[job:warranty-expiry] done — ${alertsSent} alerts sent`);
}
