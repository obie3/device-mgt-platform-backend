import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';
import { sendOffboardingAlert } from '../services/notification.service.js';

const createEmployeeBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  department: z.string().optional(),
});

const updateEmployeeBody = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  department: z.string().optional(),
});

const listQuery = z.object({
  search: z.string().optional(),
  status: z.enum(['active', 'offboarded']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export default async function employeeRoutes(fastify: FastifyInstance) {
  const auth = [fastify.authenticate];
  const operator = [fastify.authenticate, requireRole('operator')];

  // GET /api/v1/employees
  fastify.get('/employees', { preHandler: auth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    const { orgId } = request.user;
    const { search, status, page, limit } = query.data;

    const where: Record<string, unknown> = { orgId };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { department: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [employees, total] = await Promise.all([
      fastify.prisma.employee.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { name: 'asc' },
        include: {
          assignments: {
            where: { returnedAt: null },
            include: {
              device: {
                select: { id: true, serial: true, model: true, type: true },
              },
            },
          },
        },
      }),
      fastify.prisma.employee.count({ where }),
    ]);

    return reply.send({
      data: employees.map((e) => ({
        ...e,
        currentDevices: e.assignments.map((a) => a.device),
        assignments: undefined,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  });

  // POST /api/v1/employees
  fastify.post(
    '/employees',
    { preHandler: operator },
    async (request, reply) => {
      const parsed = createEmployeeBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const { orgId, sub: userId } = request.user;

      const existing = await fastify.prisma.employee.findUnique({
        where: { orgId_email: { orgId, email: parsed.data.email } },
      });
      if (existing) {
        return reply.status(409).send({ error: 'Employee email already exists' });
      }

      const employee = await fastify.prisma.employee.create({
        data: { orgId, ...parsed.data },
      });

      await logAudit(fastify.prisma, {
        orgId,
        userId,
        action: 'employee.created',
        resourceType: 'employee',
        resourceId: employee.id,
        payload: parsed.data,
      });

      return reply.status(201).send(employee);
    }
  );

  // GET /api/v1/employees/:id
  fastify.get(
    '/employees/:id',
    { preHandler: auth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { orgId } = request.user;

      const employee = await fastify.prisma.employee.findFirst({
        where: { id, orgId },
        include: {
          assignments: {
            orderBy: { assignedAt: 'desc' },
            include: {
              device: {
                select: { id: true, serial: true, model: true, type: true },
              },
            },
          },
        },
      });

      if (!employee) {
        return reply.status(404).send({ error: 'Employee not found' });
      }

      return reply.send(employee);
    }
  );

  // PATCH /api/v1/employees/:id
  fastify.patch(
    '/employees/:id',
    { preHandler: operator },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { orgId, sub: userId } = request.user;

      const parsed = updateEmployeeBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const employee = await fastify.prisma.employee.findFirst({
        where: { id, orgId },
      });
      if (!employee) {
        return reply.status(404).send({ error: 'Employee not found' });
      }

      const updated = await fastify.prisma.employee.update({
        where: { id },
        data: parsed.data,
      });

      await logAudit(fastify.prisma, {
        orgId,
        userId,
        action: 'employee.updated',
        resourceType: 'employee',
        resourceId: id,
        payload: parsed.data,
      });

      return reply.send(updated);
    }
  );

  // POST /api/v1/employees/:id/offboard
  fastify.post(
    '/employees/:id/offboard',
    { preHandler: operator },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { orgId, sub: userId } = request.user;

      const employee = await fastify.prisma.employee.findFirst({
        where: { id, orgId, status: 'active' },
        include: {
          assignments: {
            where: { returnedAt: null },
            include: {
              device: { select: { id: true, serial: true, model: true } },
            },
          },
        },
      });
      if (!employee) {
        return reply.status(404).send({ error: 'Employee not found or already offboarded' });
      }

      // Mark employee offboarded
      await fastify.prisma.employee.update({
        where: { id },
        data: { status: 'offboarded' },
      });

      await logAudit(fastify.prisma, {
        orgId,
        userId,
        action: 'employee.offboarded',
        resourceType: 'employee',
        resourceId: id,
        payload: {
          assignedDevices: employee.assignments.map((a) => a.device.id),
        },
      });

      // Notify IT of unrecovered devices
      if (employee.assignments.length > 0) {
        const itUser = await fastify.prisma.user.findFirst({
          where: { orgId, role: 'admin' },
          select: { email: true },
        });

        if (itUser) {
          sendOffboardingAlert({
            itEmail: itUser.email,
            employeeName: employee.name,
            devices: employee.assignments.map((a) => ({
              model: a.device.model,
              serial: a.device.serial,
            })),
          }).catch((err) =>
            fastify.log.error({ err }, 'Failed to send offboarding alert')
          );
        }
      }

      return reply.send({
        ok: true,
        assignedDevices: employee.assignments.map((a) => a.device),
      });
    }
  );
}
