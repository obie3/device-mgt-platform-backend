# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn run dev              # Start dev server with hot reload (tsx watch)
yarn run build            # Compile TypeScript to dist/
yarn start                # Run compiled production server
yarn run lint             # ESLint on src/

yarn run db:generate      # Regenerate Prisma client after schema changes
yarn run db:migrate       # Create and apply migrations (dev)
yarn run db:migrate:deploy # Apply migrations (production)
yarn run db:seed          # Seed initial admin user and org
yarn run db:studio        # Open Prisma Studio GUI
```

There are no automated tests. The API can be manually tested with curl after running `npm run dev`.

## Architecture

**dmp-api** is a multi-tenant REST API for IT device lifecycle management, built with Fastify + TypeScript + Prisma (PostgreSQL).

### Request Flow

```
src/server.ts → src/app.ts (plugins + routes)
    ├── plugins/prisma.ts   → decorates fastify with fastify.prisma
    ├── plugins/auth.ts     → JWT verification via @fastify/jwt
    └── routes/*.ts         → register under /api/v1/*
            ↓
    middleware/rbac.ts      → role checks (admin / operator / viewer)
            ↓
    services/               → business logic, token generation, notifications, audit writes
```

### Multi-tenancy

Every Prisma query is scoped by `organizationId` derived from the authenticated user's JWT. Never query across organizations — always include `where: { organizationId: user.organizationId }`.

### Key Entities (Prisma schema)

- **Organization** — top-level tenant
- **User** — platform login accounts (not the same as employees)
- **Employee** — people who hold devices; managed separately from Users
- **Device** — physical assets (laptop, mobile, tablet) with serial numbers
- **DeviceAssignment** — device → employee mapping; has an acknowledgment flow (employee acknowledges receipt via a public token-based endpoint)
- **AuditLog / Alert** — append-only compliance records; never mutate

### Background Jobs (`src/jobs/`)

Scheduled via `pg-boss` (uses PostgreSQL as job queue). Registered in `src/jobs/scheduler.ts`:
- `stale-device` — daily 8:00 AM, alerts on devices with no recent check-in
- `unassigned-device` — daily 8:05 AM, alerts on devices unassigned too long
- Token cleanup — 3:00 AM Sundays

### Validation & Config

- All environment variables validated at startup in `src/config.ts` using Zod; the server won't start with missing/invalid config
- Route input validation uses Fastify's built-in JSON Schema validation (not Zod)
- Passwords hashed with bcryptjs; refresh tokens stored as hashes in DB

### Notifications

`src/services/notification.service.ts` sends email (Nodemailer/SMTP) and Slack (webhook) alerts. Both are optional — configured via env vars, skipped if not set.
