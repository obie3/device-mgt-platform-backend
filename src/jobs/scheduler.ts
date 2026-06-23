import PgBoss from 'pg-boss';
import { PrismaClient } from '@prisma/client';
import { config } from '../config.js';
import { runStaleDeviceJob } from './stale-device.job.js';
import { runUnassignedDeviceJob } from './unassigned-device.job.js';

let boss: PgBoss | null = null;

export async function startScheduler(prisma: PrismaClient) {
  boss = new PgBoss(config.DATABASE_URL);

  boss.on('error', (error) => {
    console.error('[pg-boss] error:', error);
  });

  await boss.start();

  // Schedule: stale device check daily at 08:00
  await boss.schedule('stale-device-check', '0 8 * * *');
  await boss.work('stale-device-check', async () => {
    await runStaleDeviceJob(prisma);
  });

  // Schedule: unassigned device check daily at 08:05
  await boss.schedule('unassigned-device-check', '5 8 * * *');
  await boss.work('unassigned-device-check', async () => {
    await runUnassignedDeviceJob(prisma);
  });

  // Cleanup expired refresh tokens weekly
  await boss.schedule('cleanup-refresh-tokens', '0 3 * * 0');
  await boss.work('cleanup-refresh-tokens', async () => {
    await prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
  });

  console.log('[scheduler] pg-boss started — jobs scheduled');
}

export async function stopScheduler() {
  if (boss) await boss.stop();
}
