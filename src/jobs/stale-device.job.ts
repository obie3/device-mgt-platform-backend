import { PrismaClient } from '@prisma/client';
import { sendStaleDeviceAlert } from '../services/notification.service.js';

export async function runStaleDeviceJob(prisma: PrismaClient) {
  console.log('[job:stale-device] starting');

  // Get all orgs with their thresholds
  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      staleThresholdDays: true,
      users: {
        where: { role: 'admin', isActive: true },
        select: { email: true },
        take: 1,
      },
    },
  });

  let alertsSent = 0;

  for (const org of orgs) {
    const cutoff = new Date(
      Date.now() - org.staleThresholdDays * 24 * 60 * 60 * 1000
    );

    // Devices that haven't checked in and have no open stale alert
    const staleDevices = await prisma.device.findMany({
      where: {
        orgId: org.id,
        status: 'active',
        OR: [{ lastSeen: null }, { lastSeen: { lt: cutoff } }],
        alerts: {
          none: { type: 'stale_device', resolvedAt: null },
        },
      },
    });

    const itEmail = org.users[0]?.email;

    for (const device of staleDevices) {
      // Create alert record
      await prisma.alert.create({
        data: {
          deviceId: device.id,
          type: 'stale_device',
          message: `Device ${device.model} (${device.serial}) has not checked in since ${device.lastSeen?.toISOString() ?? 'never'}`,
        },
      });

      if (itEmail) {
        await sendStaleDeviceAlert({
          itEmail,
          deviceModel: device.model,
          deviceSerial: device.serial,
          lastSeen: device.lastSeen,
          staleThresholdDays: org.staleThresholdDays,
        });
      }

      alertsSent++;
    }
  }

  console.log(`[job:stale-device] done — ${alertsSent} alerts sent`);
}
