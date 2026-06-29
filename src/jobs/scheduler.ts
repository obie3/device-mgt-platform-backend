import PgBoss from 'pg-boss';
import { PrismaClient } from '@prisma/client';
import { config } from '../config.js';
import { runUnassignedDeviceJob } from './unassigned-device.job.js';
import { runWarrantyExpiryJob } from './warranty-expiry.job.js';

let boss: PgBoss | null = null;

export async function startScheduler(prisma: PrismaClient) {
  boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    // Reduce maintenance polling frequency — default is every 2s per worker
    // which adds constant DB queries. These are daily cron jobs, 30s resolution is fine.
    monitorStateIntervalSeconds: 30,
  });

  boss.on('error', (error) => {
    console.error('[pg-boss] error:', error);
  });

  await boss.start();

  // Poll every 60s — these are daily cron jobs, sub-minute latency is unnecessary.
  // JobPollingOptions uses newJobCheckIntervalSeconds, not pollingIntervalSeconds.
  const workerOpts: PgBoss.WorkOptions = { newJobCheckIntervalSeconds: 60 };

  // Schedule: unassigned device check daily at 08:00
  await boss.schedule('unassigned-device-check', '0 8 * * *');
  await boss.work('unassigned-device-check', workerOpts, async () => {
    await runUnassignedDeviceJob(prisma);
  });

  // Schedule: warranty expiry check daily at 09:00
  await boss.schedule('warranty-expiry-check', '0 9 * * *');
  await boss.work('warranty-expiry-check', workerOpts, async () => {
    await runWarrantyExpiryJob(prisma);
  });

  // Cleanup expired refresh tokens weekly (Sunday 03:00)
  await boss.schedule('cleanup-refresh-tokens', '0 3 * * 0');
  await boss.work('cleanup-refresh-tokens', workerOpts, async () => {
    await prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  });

  console.log('[scheduler] pg-boss started — jobs scheduled');
}

export async function stopScheduler() {
  if (boss) await boss.stop();
}
