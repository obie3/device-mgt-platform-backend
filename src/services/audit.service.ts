import { PrismaClient } from '@prisma/client';

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
      payload: params.payload ?? {},
    },
  });
}
