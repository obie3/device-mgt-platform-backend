import { buildApp } from './app.js';
import { config } from './config.js';
import { startScheduler } from './jobs/scheduler.js';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Server listening on ${config.HOST}:${config.PORT}`);

    // Start background jobs
    await startScheduler(app.prisma);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
