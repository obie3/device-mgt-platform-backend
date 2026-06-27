import { PrismaClient, Prisma } from '@prisma/client';

interface LogParams {
  orgId: string;
  userId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  payload?: Record<string, unknown>;
}

export async function logAudit(prisma: PrismaClient, params: LogParams) {
  await prisma.auditLog.create({
    data: {
      orgId: params.orgId,
      userId: params.userId ?? null,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      // Prisma Json field requires InputJsonValue, not Record<string, unknown>
      payload: (params.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}
