import fp from 'fastify-plugin';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { config } from '../config.js';

async function authPlugin(fastify: FastifyInstance) {
  // Register JWT with the access-token secret.
  // Refresh tokens use a separate secret verified manually in the auth route.
  await fastify.register(fastifyJwt, {
    secret:    config.JWT_ACCESS_SECRET,
    sign:      { algorithm: 'HS256', expiresIn: config.JWT_ACCESS_EXPIRES_IN },
    verify:    { algorithms: ['HS256'] },
  });

  // Decorate with a reusable authenticate hook
  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
        const payload = request.user as { type?: string };
        if (payload.type !== 'access') {
          return reply.status(401).send({ error: 'Invalid token type' });
        }
      } catch (err) {
        reply.status(401).send({ error: 'Unauthorized' });
      }
    }
  );
}

export default fp(authPlugin, { name: 'auth' });
