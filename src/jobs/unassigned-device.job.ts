import { PrismaClient } from '@prisma/client';
import { sendUnassignedDeviceAlert } from '../services/notification.service.js';

export async function runUnassignedDeviceJob(prisma: PrismaClient) {
  console.log('[job:unassigned-device] starting');

  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      unassignedAlertDays: true,
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
      Date.now() - org.unassignedAlertDays * 24 * 60 * 60 * 1000
    );

    // Devices with no current assignment and no open unassigned alert
    // "Unassigned since" = the returnedAt of the most recent assignment
    // For simplicity, we check devices where last assignment was returned before cutoff
    // OR devices that were registered before cutoff and never assigned
    const candidates = await prisma.device.findMany({
      where: {
        orgId: org.id,
        status: 'in_stock', // Phase 1: 'active' was renamed to 'in_stock'
        assignments: {
          none: { returnedAt: null }, // no active assignment
        },
        alerts: {
          none: { type: 'unassigned_device', resolvedAt: null },
        },
      },
      include: {
        assignments: {
          orderBy: { returnedAt: 'desc' },
          take: 1,
          select: { returnedAt: true },
        },
      },
    });

    const itEmail = org.users[0]?.email;

    for (const device of candidates) {
      const lastReturned = device.assignments[0]?.returnedAt;
      const unassignedSince = lastReturned ?? device.createdAt;

      if (unassignedSince > cutoff) continue; // not yet exceeded threshold

      await prisma.alert.create({
        data: {
          deviceId: device.id,
          type: 'unassigned_device',
          message: `Device ${device.model} (${device.serial}) has been unassigned since ${unassignedSince.toISOString()}`,
        },
      });

      if (itEmail) {
        await sendUnassignedDeviceAlert({
          itEmail,
          deviceModel: device.model,
          deviceSerial: device.serial,
          unassignedSince,
          thresholdDays: org.unassignedAlertDays,
        });
      }

      alertsSent++;
    }
  }

  console.log(`[job:unassigned-device] done — ${alertsSent} alerts sent`);
}
