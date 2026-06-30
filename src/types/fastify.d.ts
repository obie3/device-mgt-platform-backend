import { PrismaClient } from '@prisma/client';
import { UserRole } from '@prisma/client';
import '@fastify/cookie';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: {
      sub: string;    // userId
      orgId: string;
      role: UserRole;
      type: 'access';
      iat: number;
      exp: number;
    };
  }
}
