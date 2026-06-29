import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApprovalType, ApprovalStatus, DeviceStatus } from '@prisma/client';
import { requireRole }              from '../middleware/rbac.js';
import { logAudit }                 from '../services/audit.service.js';
import {
  sendApprovalRequestedEmail,
  sendApprovalResolvedEmail,
  sendAssignmentAckEmail,
  sendOffboardingAlert,
} from '../services/notification.service.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const listQuery = z.object({
  status: z.nativeEnum(ApprovalStatus).optional(),
  type:   z.nativeEnum(ApprovalType).optional(),
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
});

const rejectBody = z.object({
  reviewNote: z.string().min(1).max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Payload type helpers (what the gated routes store in approval.payload)
// ---------------------------------------------------------------------------

type AssignmentPayload = {
  employeeId:     string;
  conditionNotes: string | undefined;
  syncDepartment: boolean | undefined;
};

type DecommissionPayload = {
  decommissionReason: string;
};

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export default async function approvalRoutes(fastify: FastifyInstance) {
  const auth      = [fastify.authenticate];
  const adminOnly = [fastify.authenticate, requireRole('admin')];

  // ── GET /api/v1/approvals ─────────────────────────────────────────────────
  // Admins see all org approvals; operators/viewers see only their own requests.
  fastify.get('/approvals', { preHandler: auth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: query.error.flatten() });

    const { orgId, sub: userId, role } = request.user;
    const { status, type, page, limit } = query.data;

    const where = {
      orgId,
      ...(role !== 'admin' ? { requestedBy: userId } : {}),
      ...(status           ? { status }               : {}),
      ...(type             ? { type }                 : {}),
    };

    const [approvals, total] = await Promise.all([
      fastify.prisma.approval.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          requester: { select: { id: true, name: true, email: true } },
          reviewer:  { select: { id: true, name: true } },
          device: {
            select: {
              id: true, serial: true, model: true, type: true,
              manufacturer:     true,
              purchaseDate:     true,
              purchasePrice:    true,
              warrantyStart:    true,
              warrantyEnd:      true,
              warrantyProvider: true,
              images: {
                select:  { id: true, filename: true },
                orderBy: { createdAt: 'asc' },
                take:    1,
              },
            },
          },
          employee:  { select: { id: true, name: true, email: true } },
        },
      }),
      fastify.prisma.approval.count({ where }),
    ]);

    // Attach computed image URL (filename → /uploads/<filename>)
    const data = approvals.map((a) => ({
      ...a,
      device: a.device
        ? {
            ...a.device,
            images: a.device.images.map((img) => ({
              ...img,
              url: `/uploads/${img.filename}`,
            })),
          }
        : null,
    }));

    return reply.send({
      data,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  });

  // ── POST /api/v1/approvals/:id/approve ───────────────────────────────────
  fastify.post(
    '/approvals/:id/approve',
    { preHandler: adminOnly },
    async (request, reply) => {
      const { id }                  = request.params as { id: string };
      const { orgId, sub: userId }  = request.user;

      const approval = await fastify.prisma.approval.findFirst({
        where: { id, orgId, status: 'pending' },
        include: {
          device:    true,
          employee:  true,
          requester: { select: { id: true, name: true, email: true } },
        },
      });
      if (!approval) {
        return reply.status(404).send({ error: 'Approval not found or already resolved' });
      }

      // ── assignment ────────────────────────────────────────────────────────
      if (approval.type === 'assignment') {
        const p = approval.payload as AssignmentPayload;

        const [device, employee] = await Promise.all([
          fastify.prisma.device.findFirst({ where: { id: approval.deviceId!, orgId } }),
          fastify.prisma.employee.findFirst({
            where: { id: p.employeeId, orgId, status: 'active' },
          }),
        ]);

        if (!device || device.status !== 'in_stock') {
          return reply.status(409).send({
            error: 'Device is no longer available for assignment',
          });
        }
        if (!employee) {
          return reply.status(409).send({ error: 'Employee is no longer active' });
        }

        const ackToken  = crypto.randomUUID();
        const ackExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const syncDeptId =
          p.syncDepartment && employee.departmentId ? employee.departmentId : undefined;

        const assignment = await fastify.prisma.$transaction(async (tx) => {
          // Close any stale open assignment
          await tx.deviceAssignment.updateMany({
            where: { deviceId: device.id, returnedAt: null },
            data:  { returnedAt: new Date() },
          });
          const created = await tx.deviceAssignment.create({
            data: {
              deviceId:             device.id,
              employeeId:           employee.id,
              conditionNotes:       p.conditionNotes,
              acknowledgeToken:     ackToken,
              acknowledgeExpiresAt: ackExpiry,
            },
          });
          await tx.device.update({
            where: { id: device.id },
            data: {
              status: 'assigned' as DeviceStatus,
              ...(syncDeptId ? { departmentId: syncDeptId } : {}),
            },
          });
          // Resolve any unassigned alert
          await tx.alert.updateMany({
            where: { deviceId: device.id, type: 'unassigned_device', resolvedAt: null },
            data:  { resolvedAt: new Date() },
          });
          await tx.approval.update({
            where: { id: approval.id },
            data:  { status: 'approved', reviewedBy: userId, resolvedAt: new Date() },
          });
          return created;
        });

        await logAudit(fastify.prisma, {
          orgId, userId,
          action: 'device.assigned',
          resourceType: 'device',
          resourceId: device.id,
          payload: { employeeId: employee.id, employeeName: employee.name, approvalId: approval.id },
        });

        sendAssignmentAckEmail({
          assigneeEmail:  employee.email,
          assigneeName:   employee.name,
          deviceModel:    device.model,
          deviceSerial:   device.serial,
          conditionNotes: p.conditionNotes ?? null,
          ackToken,
        }).catch((err) => fastify.log.error({ err }, 'Failed to send ack email'));

        sendApprovalResolvedEmail({
          requesterEmail: approval.requester.email,
          requesterName:  approval.requester.name,
          type:           'assignment',
          approved:       true,
          deviceModel:    device.model,
          deviceSerial:   device.serial,
          employeeName:   employee.name,
        }).catch((err) => fastify.log.error({ err }, 'Failed to send approval resolved email'));

        return reply.send({ ok: true, assignment });
      }

      // ── decommission ──────────────────────────────────────────────────────
      if (approval.type === 'decommission') {
        const p = approval.payload as DecommissionPayload;

        const device = await fastify.prisma.device.findFirst({
          where: { id: approval.deviceId!, orgId },
        });
        if (!device || device.status === 'decommissioned') {
          return reply.status(409).send({
            error: 'Device is already decommissioned or not found',
          });
        }

        await fastify.prisma.$transaction(async (tx) => {
          // Close any open assignment
          await tx.deviceAssignment.updateMany({
            where: { deviceId: device.id, returnedAt: null },
            data:  { returnedAt: new Date() },
          });
          await tx.device.update({
            where: { id: device.id },
            data:  {
              status:             'decommissioned' as DeviceStatus,
              decommissionReason: p.decommissionReason,
            },
          });
          await tx.approval.update({
            where: { id: approval.id },
            data:  { status: 'approved', reviewedBy: userId, resolvedAt: new Date() },
          });
        });

        await logAudit(fastify.prisma, {
          orgId, userId,
          action: 'device.decommissioned',
          resourceType: 'device',
          resourceId: device.id,
          payload: { decommissionReason: p.decommissionReason, approvalId: approval.id },
        });

        sendApprovalResolvedEmail({
          requesterEmail: approval.requester.email,
          requesterName:  approval.requester.name,
          type:           'decommission',
          approved:       true,
          deviceModel:    device.model,
          deviceSerial:   device.serial,
        }).catch((err) => fastify.log.error({ err }, 'Failed to send approval resolved email'));

        return reply.send({ ok: true });
      }

      // ── offboard ──────────────────────────────────────────────────────────
      if (approval.type === 'offboard') {
        const employee = await fastify.prisma.employee.findFirst({
          where: { id: approval.employeeId!, orgId, status: 'active' },
          include: {
            assignments: {
              where:   { returnedAt: null },
              include: { device: { select: { id: true, serial: true, model: true } } },
            },
          },
        });
        if (!employee) {
          return reply.status(409).send({
            error: 'Employee is no longer active or not found',
          });
        }

        await fastify.prisma.$transaction(async (tx) => {
          await tx.employee.update({
            where: { id: employee.id },
            data:  { status: 'offboarded' },
          });
          if (employee.assignments.length > 0) {
            await tx.deviceAssignment.updateMany({
              where: { employeeId: employee.id, returnedAt: null },
              data:  { returnedAt: new Date() },
            });
          }
          await tx.approval.update({
            where: { id: approval.id },
            data:  { status: 'approved', reviewedBy: userId, resolvedAt: new Date() },
          });
        });

        await logAudit(fastify.prisma, {
          orgId, userId,
          action: 'employee.offboarded',
          resourceType: 'employee',
          resourceId: employee.id,
          payload: {
            assignedDevices: employee.assignments.map((a) => a.device.id),
            approvalId: approval.id,
          },
        });

        if (employee.assignments.length > 0) {
          const itUser = await fastify.prisma.user.findFirst({
            where:  { orgId, role: 'admin' },
            select: { email: true },
          });
          if (itUser) {
            sendOffboardingAlert({
              itEmail:      itUser.email,
              employeeName: employee.name,
              devices: employee.assignments.map((a) => ({
                model:  a.device.model,
                serial: a.device.serial,
              })),
            }).catch((err) => fastify.log.error({ err }, 'Failed to send offboarding alert'));
          }
        }

        sendApprovalResolvedEmail({
          requesterEmail: approval.requester.email,
          requesterName:  approval.requester.name,
          type:           'offboard',
          approved:       true,
          employeeName:   employee.name,
        }).catch((err) => fastify.log.error({ err }, 'Failed to send approval resolved email'));

        return reply.send({
          ok: true,
          assignedDevices: employee.assignments.map((a) => a.device),
        });
      }

      return reply.status(400).send({ error: 'Unknown approval type' });
    }
  );

  // ── POST /api/v1/approvals/:id/reject ────────────────────────────────────
  fastify.post(
    '/approvals/:id/reject',
    { preHandler: adminOnly },
    async (request, reply) => {
      const { id }                 = request.params as { id: string };
      const { orgId, sub: userId } = request.user;

      const parsed = rejectBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const approval = await fastify.prisma.approval.findFirst({
        where: { id, orgId, status: 'pending' },
        include: {
          requester: { select: { id: true, name: true, email: true } },
          device:    { select: { id: true, model: true, serial: true } },
          employee:  { select: { id: true, name: true } },
        },
      });
      if (!approval) {
        return reply.status(404).send({ error: 'Approval not found or already resolved' });
      }

      await fastify.prisma.approval.update({
        where: { id },
        data: {
          status:     'rejected',
          reviewedBy: userId,
          resolvedAt: new Date(),
          reviewNote: parsed.data.reviewNote,
        },
      });

      await logAudit(fastify.prisma, {
        orgId, userId,
        action: 'approval.rejected',
        resourceType: 'approval',
        resourceId: id,
        payload: { type: approval.type, reviewNote: parsed.data.reviewNote },
      });

      sendApprovalResolvedEmail({
        requesterEmail: approval.requester.email,
        requesterName:  approval.requester.name,
        type:           approval.type,
        approved:       false,
        reviewNote:     parsed.data.reviewNote,
        ...(approval.device   ? { deviceModel: approval.device.model, deviceSerial: approval.device.serial } : {}),
        ...(approval.employee ? { employeeName: approval.employee.name }                                      : {}),
      }).catch((err) => fastify.log.error({ err }, 'Failed to send rejection email'));

      return reply.send({ ok: true });
    }
  );
}
