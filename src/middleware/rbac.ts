import { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { UserRole } from '@prisma/client';

const ROLE_HIERARCHY: Record<UserRole, number> = {
  admin: 3,
  operator: 2,
  viewer: 1,
};

/**
 * Returns a preHandler that enforces a minimum role.
 * Usage: { preHandler: [fastify.authenticate, requireRole('operator')] }
 */
export function requireRole(minRole: UserRole) {
  return (
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ) => {
    const userRole = request.user?.role;
    if (!userRole || ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minRole]) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    done();
  };
}
