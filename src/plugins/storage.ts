import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { createStorageProvider } from '../services/storage/index.js';
import type { StorageProvider }  from '../services/storage/index.js';
import { config }                from '../config.js';

// Augment FastifyInstance so routes get full type-safety on fastify.storage
declare module 'fastify' {
  interface FastifyInstance {
    storage: StorageProvider;
  }
}

/**
 * Registers the configured StorageProvider as `fastify.storage`.
 * Uses fastify-plugin (fp) to break encapsulation so the decorator is
 * visible to all route plugins, not just children of this scope.
 */
const storagePlugin: FastifyPluginAsync = async (fastify) => {
  const provider = createStorageProvider(config);
  fastify.decorate('storage', provider);
  fastify.log.info(`[storage] provider: ${config.STORAGE_PROVIDER}`);
};

export default fp(storagePlugin, { name: 'storage' });
