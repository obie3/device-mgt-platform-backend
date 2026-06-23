import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';

async function prismaPlugin(fastify: FastifyInstance) {
  const prisma = new PrismaClient({
    log: ['warn', 'error'], // 'query' logging adds overhead; enable manually when needed
  });

  await prisma.$connect();

  fastify.decorate('prisma', prisma);

  fastify.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
}

export default fp(prismaPlugin, { name: 'prisma' });
