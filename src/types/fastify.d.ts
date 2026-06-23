import { PrismaClient } from '@prisma/client';
import { UserRole } from '@prisma/client';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }

  interface FastifyRequest {
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
