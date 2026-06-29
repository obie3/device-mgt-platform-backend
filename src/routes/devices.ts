import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DeviceStatus, DeviceType, Prisma } from '@prisma/client';
import { requireRole }            from '../middleware/rbac.js';
import { logAudit }               from '../services/audit.service.js';
import { parse as csvParse }      from 'csv-parse/sync';
import {
  sendAssignmentAckEmail,
  sendApprovalRequestedEmail,
} from '../services/notification.service.js';

const MAX_IMAGE_SIZE   = 3 * 1024 * 1024; // 3 MB
const MAX_IMAGES       = 5;
const ALLOWED_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// ---------------------------------------------------------------------------
// Status state machine — enforced in the PATCH route.
// assigned → in_stock is NOT allowed directly; must go through /unassign.
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS: Record<DeviceStatus, DeviceStatus[]> = {
  in_stock:       ['assigned', 'under_repair', 'decommissioned'],
  assigned:       ['under_repair', 'decommissioned'],
  under_repair:   ['in_stock', 'decommissioned'],
  // Admins can reactivate a decommissioned device; enforced below
  decommissioned: ['in_stock', 'under_repair'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute warranty status relative to today. */
function warrantyStatus(warrantyEnd: Date | null): 'active' | 'expiring' | 'expired' | null {
  if (!warrantyEnd) return null;
  const now  = new Date();
  const diff = warrantyEnd.getTime() - now.getTime();
  if (diff < 0) return 'expired';
  if (diff < 30 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const sharedDeviceFields = {
  manufacturer:    z.string().max(100).optional(),
  model:           z.string().min(1).max(200).optional(),
  assetTag:        z.string().max(50).optional(),
  // Phase 3: departmentId/locationId replace the old department/location strings
  departmentId:    z.string().nullable().optional(),
  locationId:      z.string().nullable().optional(),
  costCenter:      z.string().max(100).optional(),
  supplier:        z.string().max(200).optional(),
  purchaseDate:    z.string().optional(),
  purchasePrice:   z.number().nonnegative().optional(),
  warrantyStart:   z.string().optional(),
  warrantyEnd:     z.string().optional(),
  warrantyProvider: z.string().max(200).optional(),
  notes:           z.string().max(2000).optional(),
};

const createDeviceBody = z.object({
  serial: z.string().min(1).max(100),
  type:   z.nativeEnum(DeviceType),
  ...sharedDeviceFields,
  // model is required for creates (overrides the optional in sharedDeviceFields)
  model: z.string().min(1).max(200),
});

const updateDeviceBody = z
  .object({
    status:             z.nativeEnum(DeviceStatus).optional(),
    decommissionReason: z.string().min(1).max(1000).optional(),
    ...sharedDeviceFields,
  })
  .superRefine((val, ctx) => {
    if (val.status === 'decommissioned' && !val.decommissionReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decommissionReason'],
        message: 'Reason for decommissioning is required',
      });
    }
  });

const assignBody = z.object({
  employeeId:      z.string(),
  conditionNotes:  z.string().max(2000).optional(),
  /** When true: look up employee.department by name in the org's departments
   *  and set device.departmentId to the matched row (no-op if no match). */
  syncDepartment:  z.boolean().optional(),
});

const listQuery = z.object({
  type:             z.nativeEnum(DeviceType).optional(),
  status:           z.nativeEnum(DeviceStatus).optional(),
  assigned:         z.enum(['true', 'false']).optional(),
  search:           z.string().max(200).optional(),
  departmentId:     z.string().optional(),
  locationId:       z.string().optional(),
  costCenter:       z.string().max(100).optional(),
  /** Return only devices whose warranty expires within N days */
  warrantyExpiring: z.coerce.number().int().min(1).max(365).optional(),
  /** Return only devices whose warranty has already expired */
  warrantyExpired:  z.enum(['true']).optional(),
  page:             z.coerce.number().int().min(1).default(1),
  limit:            z.coerce.number().int().min(1).max(100).default(20),
});

export default async function deviceRoutes(fastify: FastifyInstance) {
  const auth     = [fastify.authenticate];
  const operator = [fastify.authenticate, requireRole('operator')];

  // ── GET /api/v1/devices ────────────────────────────────────────────────────
  fastify.get('/devices', { preHandler: auth }, async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.flatten() });
    }

    const { orgId } = request.user;
    const { type, status, assigned, search, departmentId, locationId, costCenter, warrantyExpiring, warrantyExpired, page, limit } = query.data;

    const where: Prisma.DeviceWhereInput = { orgId };
    if (type)         where.type         = type;
    if (status)       where.status       = status;
    if (departmentId) where.departmentId = departmentId;
    if (locationId)   where.locationId   = locationId;
    if (costCenter)   where.costCenter   = { equals: costCenter, mode: 'insensitive' };
    if (search) {
      where.OR = [
        { serial:     { contains: search, mode: 'insensitive' } },
        { model:      { contains: search, mode: 'insensitive' } },
        { assetTag:   { contains: search, mode: 'insensitive' } },
        { department: { name: { contains: search, mode: 'insensitive' } } },
        { location:   { name: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (warrantyExpired) {
      where.warrantyEnd = { lt: new Date() };
    } else if (warrantyExpiring) {
      const horizon = new Date(Date.now() + warrantyExpiring * 24 * 60 * 60 * 1000);
      where.warrantyEnd = { gte: new Date(), lte: horizon };
    }

    const [devices, total] = await Promise.all([
      fastify.prisma.device.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          department: { select: { id: true, name: true } },
          location:   { select: { id: true, name: true } },
          assignments: {
            where: { returnedAt: null },
            include: { employee: { select: { id: true, name: true, email: true } } },
            take: 1,
          },
        },
      }),
      fastify.prisma.device.count({ where }),
    ]);

    let filtered = devices;
    if (assigned === 'true')  filtered = devices.filter((d) => d.assignments.length > 0);
    if (assigned === 'false') filtered = devices.filter((d) => d.assignments.length === 0);

    return reply.send({
      data: filtered.map((d) => ({
        ...d,
        currentAssignment: d.assignments[0] ?? null,
        assignments:       undefined,
        warrantyStatus:    warrantyStatus(d.warrantyEnd),
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  });

  // ── POST /api/v1/devices ───────────────────────────────────────────────────
  fastify.post('/devices', { preHandler: operator }, async (request, reply) => {
    const parsed = createDeviceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const { orgId, sub: userId } = request.user;

    const existing = await fastify.prisma.device.findUnique({
      where: { orgId_serial: { orgId, serial: parsed.data.serial } },
    });
    if (existing) {
      return reply.status(409).send({ error: 'Serial number already registered' });
    }

    const device = await fastify.prisma.device.create({
      data: {
        orgId,
        serial:          parsed.data.serial,
        type:            parsed.data.type,
        manufacturer:    parsed.data.manufacturer,
        model:           parsed.data.model,
        assetTag:        parsed.data.assetTag      || undefined,
        departmentId:    parsed.data.departmentId  ?? undefined,
        locationId:      parsed.data.locationId    ?? undefined,
        costCenter:      parsed.data.costCenter    || undefined,
        supplier:        parsed.data.supplier      || undefined,
        purchasePrice:   parsed.data.purchasePrice != null ? parsed.data.purchasePrice : undefined,
        purchaseDate:    parsed.data.purchaseDate  ? new Date(parsed.data.purchaseDate)  : undefined,
        warrantyStart:   parsed.data.warrantyStart ? new Date(parsed.data.warrantyStart) : undefined,
        warrantyEnd:     parsed.data.warrantyEnd   ? new Date(parsed.data.warrantyEnd)   : undefined,
        warrantyProvider: parsed.data.warrantyProvider || undefined,
        notes:           parsed.data.notes,
      },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.created',
      resourceType: 'device',
      resourceId: device.id,
      payload: { serial: device.serial, type: device.type, model: device.model },
    });

    return reply.status(201).send(device);
  });

  // ── POST /api/v1/devices/import ────────────────────────────────────────────
  // CSV columns (header required):
  //   serial, type, model, manufacturer*, assetTag*, department*, location*,
  //   costCenter*, supplier*, purchaseDate*, purchasePrice*, warrantyStart*,
  //   warrantyEnd*, warrantyProvider*, notes*   (* = optional)
  fastify.post('/devices/import', { preHandler: operator }, async (request, reply) => {
    const { orgId, sub: userId } = request.user;

    // Read multipart file
    const data = await request.file();
    if (!data) return reply.status(400).send({ error: 'No file uploaded' });
    if (!data.filename.toLowerCase().endsWith('.csv')) {
      return reply.status(400).send({ error: 'Only .csv files are accepted' });
    }

    const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2 MB
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of data.file) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_CSV_BYTES) {
        return reply.status(413).send({ error: 'CSV file exceeds the 2 MB limit' });
      }
      chunks.push(chunk);
    }
    const csvText = Buffer.concat(chunks).toString('utf-8');

    // Parse CSV
    let rows: Record<string, string>[];
    try {
      rows = csvParse(csvText, { columns: true, skip_empty_lines: true, trim: true });
    } catch {
      return reply.status(400).send({ error: 'Failed to parse CSV — ensure it has a header row and uses comma delimiters' });
    }

    if (rows.length === 0) return reply.status(400).send({ error: 'CSV contains no data rows' });
    if (rows.length > 500) return reply.status(400).send({ error: 'CSV exceeds 500 row limit per import' });

    // Pre-load org departments and locations for name→id resolution
    const [departments, locations] = await Promise.all([
      fastify.prisma.department.findMany({ where: { orgId }, select: { id: true, name: true } }),
      fastify.prisma.location.findMany({   where: { orgId }, select: { id: true, name: true } }),
    ]);
    const deptMap = new Map(departments.map((d) => [d.name.toLowerCase(), d.id]));
    const locMap  = new Map(locations.map((l)  => [l.name.toLowerCase(), l.id]));

    const VALID_TYPES = new Set(Object.values(DeviceType));

    const imported: string[] = [];
    const errors: { row: number; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const rowNum = i + 2; // 1-based, +1 for header

      const serial = row['serial']?.trim();
      const type   = row['type']?.trim().toLowerCase();
      const model  = row['model']?.trim();

      // Required fields
      if (!serial)               { errors.push({ row: rowNum, error: 'Missing serial' });       continue; }
      if (!type)                 { errors.push({ row: rowNum, error: 'Missing type' });         continue; }
      if (!VALID_TYPES.has(type as DeviceType)) {
        errors.push({ row: rowNum, error: `Invalid type "${type}". Valid: ${[...VALID_TYPES].join(', ')}` });
        continue;
      }
      if (!model)                { errors.push({ row: rowNum, error: 'Missing model' });        continue; }

      // Duplicate serial check within this org
      const existing = await fastify.prisma.device.findUnique({
        where: { orgId_serial: { orgId, serial } },
      });
      if (existing) { errors.push({ row: rowNum, error: `Serial "${serial}" already exists` }); continue; }

      // Optional FK resolution
      const deptName = row['department']?.trim();
      const locName  = row['location']?.trim();
      const departmentId = deptName ? (deptMap.get(deptName.toLowerCase()) ?? null) : null;
      const locationId   = locName  ? (locMap.get(locName.toLowerCase())   ?? null) : null;

      // Optional numerics
      const purchasePriceRaw = row['purchasePrice']?.trim();
      const purchasePrice    = purchasePriceRaw ? parseFloat(purchasePriceRaw) : undefined;

      try {
        const device = await fastify.prisma.device.create({
          data: {
            orgId,
            serial,
            type:             type as DeviceType,
            model,
            manufacturer:     row['manufacturer']?.trim()     || undefined,
            assetTag:         row['assetTag']?.trim()         || undefined,
            costCenter:       row['costCenter']?.trim()       || undefined,
            supplier:         row['supplier']?.trim()         || undefined,
            notes:            row['notes']?.trim()            || undefined,
            warrantyProvider: row['warrantyProvider']?.trim() || undefined,
            departmentId,
            locationId,
            purchasePrice:    purchasePrice && !isNaN(purchasePrice) ? purchasePrice : undefined,
            purchaseDate:     row['purchaseDate']?.trim()    ? new Date(row['purchaseDate']!.trim())    : undefined,
            warrantyStart:    row['warrantyStart']?.trim()   ? new Date(row['warrantyStart']!.trim())   : undefined,
            warrantyEnd:      row['warrantyEnd']?.trim()     ? new Date(row['warrantyEnd']!.trim())     : undefined,
          },
        });
        imported.push(device.id);
      } catch {
        errors.push({ row: rowNum, error: `Failed to create device "${serial}"` });
      }
    }

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.bulk_imported',
      resourceType: 'device',
      resourceId: orgId,
      payload: { imported: imported.length, errors: errors.length },
    });

    return reply.status(200).send({
      imported: imported.length,
      skipped:  errors.length,
      errors,
    });
  });

  // ── GET /api/v1/devices/:id ────────────────────────────────────────────────
  fastify.get('/devices/:id', { preHandler: auth }, async (request, reply) => {
    const { id }    = request.params as { id: string };
    const { orgId } = request.user;

    const [device, auditEntries] = await Promise.all([
      fastify.prisma.device.findFirst({
        where: { id, orgId },
        include: {
          department: { select: { id: true, name: true } },
          location:   { select: { id: true, name: true } },
          // asc so we can correlate with audit entries by index
          assignments: {
            orderBy: { assignedAt: 'asc' },
            include: { employee: { select: { id: true, name: true, email: true } } },
          },
          alerts:  { where: { resolvedAt: null }, orderBy: { sentAt: 'desc' } },
          images:  { orderBy: { createdAt: 'asc' } },
        },
      }),
      fastify.prisma.auditLog.findMany({
        where: {
          orgId,
          resourceType: 'device',
          resourceId: id,
          action: { in: ['device.created', 'device.assigned', 'device.unassigned'] },
        },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { ts: 'asc' },
      }),
    ]);

    if (!device) return reply.status(404).send({ error: 'Device not found' });

    // Attach assignedBy to each assignment by correlating with audit log in order
    const assignAuditEntries = auditEntries.filter((e) => e.action === 'device.assigned');
    const assignmentsWithActor = device.assignments.map((a, i) => ({
      ...a,
      assignedBy: assignAuditEntries[i]?.user ?? null,
    }));

    const createdEntry = auditEntries.find((e) => e.action === 'device.created');

    return reply.send({
      ...device,
      images:            device.images.map((img) => ({
        ...img,
        url: fastify.storage.getUrl(img.filename),
      })),
      warrantyStatus:    warrantyStatus(device.warrantyEnd),
      createdBy:         createdEntry?.user ?? null,
      assignments:       assignmentsWithActor,
      currentAssignment: assignmentsWithActor.find((a) => a.returnedAt === null) ?? null,
    });
  });

  // ── PATCH /api/v1/devices/:id ──────────────────────────────────────────────
  fastify.patch('/devices/:id', { preHandler: operator }, async (request, reply) => {
    const { id }                       = request.params as { id: string };
    const { orgId, sub: userId, role } = request.user;

    const parsed = updateDeviceBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const device = await fastify.prisma.device.findFirst({ where: { id, orgId } });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    // Validate status transition
    if (parsed.data.status && parsed.data.status !== device.status) {
      const allowed = VALID_TRANSITIONS[device.status] ?? [];
      if (!allowed.includes(parsed.data.status)) {
        return reply.status(409).send({
          error: `Cannot transition device from '${device.status}' to '${parsed.data.status}'`,
        });
      }
      // Only admins can reactivate a decommissioned device
      if (device.status === 'decommissioned' && role !== 'admin') {
        return reply.status(403).send({
          error: 'Only admins can reactivate a decommissioned device',
        });
      }
    }

    // ── Governance gate: operators must request decommission approval ─────
    if (parsed.data.status === 'decommissioned' && role !== 'admin') {
      const conflict = await fastify.prisma.approval.findFirst({
        where: { deviceId: id, orgId, status: 'pending' },
      });
      if (conflict) {
        return reply.status(409).send({
          error: 'A pending approval already exists for this device',
        });
      }

      const [approval, requester, admins] = await Promise.all([
        fastify.prisma.approval.create({
          data: {
            orgId,
            type:        'decommission',
            requestedBy: userId,
            deviceId:    id,
            payload:     { decommissionReason: parsed.data.decommissionReason },
          },
        }),
        fastify.prisma.user.findUnique({
          where:  { id: userId },
          select: { name: true },
        }),
        fastify.prisma.user.findMany({
          where:  { orgId, role: 'admin', isActive: true },
          select: { email: true },
        }),
      ]);

      await logAudit(fastify.prisma, {
        orgId, userId,
        action: 'approval.requested',
        resourceType: 'approval',
        resourceId: approval.id,
        payload: { type: 'decommission', deviceId: id },
      });

      sendApprovalRequestedEmail({
        adminEmails:   admins.map((a) => a.email),
        requesterName: requester?.name ?? 'An operator',
        type:          'decommission',
        deviceModel:   device.model,
        deviceSerial:  device.serial,
      }).catch((err) => fastify.log.error({ err }, 'Failed to send approval request email'));

      return reply.status(202).send({
        ok: true,
        approval,
        message: 'Decommission request submitted for admin approval',
      });
    }
    // ── Admin: execute directly (original flow) ───────────────────────────

    const updated = await fastify.prisma.device.update({
      where: { id },
      data: {
        manufacturer:     parsed.data.manufacturer,
        model:            parsed.data.model,
        assetTag:         parsed.data.assetTag      !== undefined ? (parsed.data.assetTag || null) : undefined,
        departmentId:     parsed.data.departmentId  !== undefined ? parsed.data.departmentId       : undefined,
        locationId:       parsed.data.locationId    !== undefined ? parsed.data.locationId         : undefined,
        costCenter:       parsed.data.costCenter    !== undefined ? (parsed.data.costCenter || null) : undefined,
        supplier:         parsed.data.supplier      !== undefined ? (parsed.data.supplier || null) : undefined,
        purchasePrice:    parsed.data.purchasePrice != null       ? parsed.data.purchasePrice       : undefined,
        warrantyProvider: parsed.data.warrantyProvider !== undefined ? (parsed.data.warrantyProvider || null) : undefined,
        purchaseDate:     parsed.data.purchaseDate  ? new Date(parsed.data.purchaseDate)  : undefined,
        warrantyStart:    parsed.data.warrantyStart ? new Date(parsed.data.warrantyStart) : undefined,
        warrantyEnd:      parsed.data.warrantyEnd   ? new Date(parsed.data.warrantyEnd)   : undefined,
        notes:            parsed.data.notes,
        status:           parsed.data.status,
        decommissionReason: parsed.data.status === 'decommissioned'
          ? parsed.data.decommissionReason
          : parsed.data.status != null ? null : undefined,
      },
    });

    // Auto-close open assignment when decommissioning or sending for repair.
    const autoCloseStatuses: DeviceStatus[] = ['decommissioned', 'under_repair'];
    if (parsed.data.status && autoCloseStatuses.includes(parsed.data.status)) {
      const reason = parsed.data.status === 'decommissioned' ? 'device_decommissioned' : 'device_under_repair';
      const closed = await fastify.prisma.deviceAssignment.updateMany({
        where: { deviceId: id, returnedAt: null },
        data: { returnedAt: new Date() },
      });
      if (closed.count > 0) {
        await logAudit(fastify.prisma, {
          orgId, userId,
          action: 'device.returned',
          resourceType: 'device',
          resourceId: id,
          payload: { reason },
        });
      }
    }

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.updated',
      resourceType: 'device',
      resourceId: id,
      payload: parsed.data,
    });

    return reply.send(updated);
  });

  // ── POST /api/v1/devices/:id/assign ───────────────────────────────────────
  fastify.post('/devices/:id/assign', { preHandler: operator }, async (request, reply) => {
    const { id: deviceId }       = request.params as { id: string };
    const { orgId, sub: userId, role } = request.user;

    const parsed = assignBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }

    const device = await fastify.prisma.device.findFirst({
      where: { id: deviceId, orgId },
    });
    if (!device) {
      return reply.status(404).send({ error: 'Device not found' });
    }
    if (device.status !== 'in_stock') {
      return reply.status(409).send({
        error: `Device is not available for assignment (current status: ${device.status})`,
      });
    }

    const employee = await fastify.prisma.employee.findFirst({
      where: { id: parsed.data.employeeId, orgId, status: 'active' },
    });
    if (!employee) {
      return reply.status(404).send({ error: 'Employee not found or not active' });
    }

    // ── Governance gate: operators submit a request; admins execute directly ──
    if (role !== 'admin') {
      // Block if a pending approval already exists for this device
      const conflict = await fastify.prisma.approval.findFirst({
        where: { deviceId, orgId, status: 'pending' },
      });
      if (conflict) {
        return reply.status(409).send({
          error: 'A pending approval already exists for this device',
        });
      }

      const [approval, requester, admins] = await Promise.all([
        fastify.prisma.approval.create({
          data: {
            orgId,
            type:        'assignment',
            requestedBy: userId,
            deviceId,
            employeeId:  employee.id,
            payload: {
              employeeId:     parsed.data.employeeId,
              conditionNotes: parsed.data.conditionNotes,
              syncDepartment: parsed.data.syncDepartment,
            },
          },
        }),
        fastify.prisma.user.findUnique({
          where:  { id: userId },
          select: { name: true },
        }),
        fastify.prisma.user.findMany({
          where:  { orgId, role: 'admin', isActive: true },
          select: { email: true },
        }),
      ]);

      await logAudit(fastify.prisma, {
        orgId, userId,
        action: 'approval.requested',
        resourceType: 'approval',
        resourceId: approval.id,
        payload: { type: 'assignment', deviceId, employeeId: employee.id },
      });

      sendApprovalRequestedEmail({
        adminEmails:   admins.map((a) => a.email),
        requesterName: requester?.name ?? 'An operator',
        type:          'assignment',
        deviceModel:   device.model,
        deviceSerial:  device.serial,
        employeeName:  employee.name,
      }).catch((err) => fastify.log.error({ err }, 'Failed to send approval request email'));

      return reply.status(202).send({
        ok: true,
        approval,
        message: 'Assignment request submitted for admin approval',
      });
    }
    // ── Admin: execute directly (original flow) ───────────────────────────

    const ackToken     = crypto.randomUUID();
    const ackExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // If syncDepartment: copy employee's departmentId directly to the device
    // (employee now has a FK departmentId, no string lookup needed)
    const syncDeptId: string | undefined =
      parsed.data.syncDepartment && employee.departmentId
        ? employee.departmentId
        : undefined;

    // Atomic: close stale assignment + create new one + update device status (+ optional dept sync)
    const [, assignment] = await fastify.prisma.$transaction([
      fastify.prisma.deviceAssignment.updateMany({
        where: { deviceId, returnedAt: null },
        data:  { returnedAt: new Date() },
      }),
      fastify.prisma.deviceAssignment.create({
        data: {
          deviceId,
          employeeId:           parsed.data.employeeId,
          conditionNotes:       parsed.data.conditionNotes,
          acknowledgeToken:     ackToken,
          acknowledgeExpiresAt: ackExpiresAt,
        },
      }),
      fastify.prisma.device.update({
        where: { id: deviceId },
        data:  {
          status: 'assigned' as DeviceStatus,
          ...(syncDeptId ? { departmentId: syncDeptId } : {}),
        },
      }),
    ]);

    // Resolve any open unassigned alert
    await fastify.prisma.alert.updateMany({
      where: { deviceId, type: 'unassigned_device', resolvedAt: null },
      data: { resolvedAt: new Date() },
    });

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.assigned',
      resourceType: 'device',
      resourceId: deviceId,
      payload: {
        employeeId:     parsed.data.employeeId,
        conditionNotes: parsed.data.conditionNotes,
      },
    });

    sendAssignmentAckEmail({
      assigneeEmail:  employee.email,
      assigneeName:   employee.name,
      deviceModel:    device.model,
      deviceSerial:   device.serial,
      conditionNotes: parsed.data.conditionNotes ?? null,
      ackToken,
    }).catch((err) => fastify.log.error({ err }, 'Failed to send ack email'));

    return reply.status(201).send(assignment);
  });

  // ── POST /api/v1/devices/:id/unassign ─────────────────────────────────────
  fastify.post('/devices/:id/unassign', { preHandler: operator }, async (request, reply) => {
    const { id: deviceId }       = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const device = await fastify.prisma.device.findFirst({ where: { id: deviceId, orgId } });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    // Atomic: close assignment + restore device status to in_stock
    const [unassignResult] = await fastify.prisma.$transaction([
      fastify.prisma.deviceAssignment.updateMany({
        where: { deviceId, returnedAt: null },
        data:  { returnedAt: new Date() },
      }),
      fastify.prisma.device.update({
        where: { id: deviceId },
        data:  { status: 'in_stock' as DeviceStatus },
      }),
    ]);

    if (unassignResult.count === 0) {
      return reply.status(409).send({ error: 'Device is not currently assigned' });
    }

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.returned',
      resourceType: 'device',
      resourceId: deviceId,
    });

    return reply.status(200).send({ ok: true });
  });

  // ── POST /api/v1/devices/:id/images ───────────────────────────────────────
  // Accepts multipart/form-data with one or more files in the "images" field.
  // Each file must be ≤ 3 MB and be an image type. Up to MAX_IMAGES total.
  fastify.post('/devices/:id/images', { preHandler: operator }, async (request, reply) => {
    const { id: deviceId }       = request.params as { id: string };
    const { orgId, sub: userId } = request.user;

    const device = await fastify.prisma.device.findFirst({
      where: { id: deviceId, orgId },
      include: { _count: { select: { images: true } } },
    });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    const existing = (device as typeof device & { _count: { images: number } })._count.images;
    if (existing >= MAX_IMAGES) {
      return reply.status(409).send({
        error: `Device already has the maximum of ${MAX_IMAGES} images`,
      });
    }

    const parts = request.parts();
    const saved: Array<{ filename: string; originalName: string; size: number; mimeType: string }> = [];
    let remaining = MAX_IMAGES - existing;

    for await (const part of parts) {
      if (part.type !== 'file') continue;
      if (remaining <= 0) break;

      const mimeType = part.mimetype;
      if (!ALLOWED_MIMETYPES.has(mimeType)) {
        await part.file.resume(); // drain the stream
        return reply.status(400).send({
          error: `Unsupported file type: ${mimeType}. Allowed: JPEG, PNG, WebP, GIF`,
        });
      }

      // Buffer the entire file before writing so we can enforce the size cap
      // without leaving partial files on disk / in cloud storage.
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of part.file) {
        totalSize += chunk.length;
        if (totalSize > MAX_IMAGE_SIZE) {
          return reply.status(413).send({
            error: `File "${part.filename}" exceeds the 3 MB limit`,
          });
        }
        chunks.push(chunk as Buffer);
      }

      const result = await fastify.storage.upload(Buffer.concat(chunks), {
        filename: part.filename || 'image.jpg',
        mimeType,
        folder:   'device-images',
      });

      saved.push({
        filename:     result.key,
        originalName: part.filename ?? 'image',
        size:         totalSize,
        mimeType,
      });
      remaining--;
    }

    if (saved.length === 0) {
      return reply.status(400).send({ error: 'No valid image files received' });
    }

    const images = await fastify.prisma.$transaction(
      saved.map((s) =>
        fastify.prisma.deviceImage.create({
          data: { deviceId, ...s },
        })
      )
    );

    await logAudit(fastify.prisma, {
      orgId, userId,
      action: 'device.images_uploaded',
      resourceType: 'device',
      resourceId: deviceId,
      payload: { count: images.length },
    });

    // Attach resolved public URL so clients don't need to know the provider
    return reply.status(201).send(
      images.map((img) => ({ ...img, url: fastify.storage.getUrl(img.filename) }))
    );
  });

  // ── GET /api/v1/devices/:id/images ────────────────────────────────────────
  fastify.get('/devices/:id/images', { preHandler: auth }, async (request, reply) => {
    const { id: deviceId } = request.params as { id: string };
    const { orgId }        = request.user;

    const device = await fastify.prisma.device.findFirst({ where: { id: deviceId, orgId } });
    if (!device) return reply.status(404).send({ error: 'Device not found' });

    const images = await fastify.prisma.deviceImage.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send(
      images.map((img) => ({ ...img, url: fastify.storage.getUrl(img.filename) }))
    );
  });

  // ── DELETE /api/v1/devices/:id/images/:imageId ────────────────────────────
  fastify.delete(
    '/devices/:id/images/:imageId',
    { preHandler: operator },
    async (request, reply) => {
      const { id: deviceId, imageId } = request.params as { id: string; imageId: string };
      const { orgId, sub: userId }    = request.user;

      const device = await fastify.prisma.device.findFirst({ where: { id: deviceId, orgId } });
      if (!device) return reply.status(404).send({ error: 'Device not found' });

      const image = await fastify.prisma.deviceImage.findFirst({
        where: { id: imageId, deviceId },
      });
      if (!image) return reply.status(404).send({ error: 'Image not found' });

      // Delete DB record first, then the stored file — if file delete fails
      // the record is already gone (acceptable). The reverse would expose dead links.
      await fastify.prisma.deviceImage.delete({ where: { id: imageId } });

      // Best-effort: provider silently swallows "not found" errors
      fastify.storage.delete(image.filename).catch(() => {});

      await logAudit(fastify.prisma, {
        orgId, userId,
        action: 'device.image_deleted',
        resourceType: 'device',
        resourceId: deviceId,
        payload: { imageId, filename: image.originalName },
      });

      return reply.status(204).send();
    }
  );
}
