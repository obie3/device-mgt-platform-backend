# Device Management Platform — API

Multi-tenant REST API for tracking IT hardware across an organisation: what you own, who is holding it, what state it is in, and who approved the change.

Fastify + Prisma + PostgreSQL on Node 22 LTS, written in TypeScript (ESM). Containerised and running in production.

## What it does

The organisation is the tenant boundary — every user, employee, device and audit record is scoped to an org.

**Inventory.** Laptops, desktops, mobiles, tablets, servers, monitors, printers and networking kit, each moving through a lifecycle of in_stock, assigned, under_repair and decommissioned.

**Assignment.** Devices are assigned to employees, with departments and locations as first-class records rather than free text.

**Approvals.** Assignment, decommission and employee offboarding each raise an approval with a requester, a reviewer and a pending / approved / rejected outcome.

**Repairs.** Repair history logged per device, so a machine's maintenance record travels with it.

**Alerts.** Devices sitting unassigned past an org-configurable threshold, and warranty expiries.

**Audit log.** Every state change recorded against the acting user.

**Analytics and reports.** Aggregate views over the fleet, plus CSV import and export.

**Device images.** Uploads validated by actual file signature, stored through a pluggable provider — local disk, S3 or Cloudinary.

## Security

Security was done as a dedicated hardening pass, tracked as numbered findings rather than left as an afterthought.

- JWT access tokens signed HS256 and delivered in HttpOnly cookies
- - Refresh tokens persisted as revocable records, separate from the access token
  - - bcrypt password hashing at cost 12
    - - Account lockout after repeated failed logins, tracked per user
      - - Single-use password reset tokens held in the database
        - - Role-based access control across admin, operator and viewer
          - - CSP and HSTS via @fastify/helmet, plus CORS and rate limiting
            - - Upload validation by magic number, not by file extension
              - - Request and body validation with zod at every route boundary
               
                - ## Architecture
               
                - - src/routes — 14 route modules: auth, users, org, devices, employees, assignments, approvals, repairs, alerts, audit, analytics, reports, departments, locations
                  - - src/services — business logic, kept out of the route layer
                    - - src/plugins — Fastify plugins for auth, security headers, storage and email
                      - - src/middleware — request-scoped concerns
                        - - src/jobs — background work on pg-boss
                          - - src/config.ts, src/app.ts, src/server.ts — configuration, app composition, entrypoint
                           
                            - Storage and email sit behind provider abstractions, so local development runs on disk and SMTP while production uses object storage and a real mail provider without changing any call site.
                           
                            - Background jobs run on pg-boss against the same PostgreSQL instance as the application, which keeps a second broker out of the deployment.
                           
                            - Prisma is configured with the library engine for faster cold starts, and builds target debian-openssl-3.0.x for the container image.
                           
                            - ## Running it
                           
                            - Requires Node 22 and PostgreSQL, or just Docker.
                           
                            - Copy the example environment file to .env, then install dependencies with npm install, apply migrations with npm run db:migrate, seed reference data with npm run db:seed, and start the dev server with npm run dev. Alternatively, docker compose up brings up the API and database together.
                           
                            - | Script | Purpose |
                            - | --- | --- |
                            - | npm run dev | run with hot reload via tsx watch |
                            - | npm run build | compile TypeScript to dist/ |
                            - | npm start | run the compiled server |
                            - | npm run lint | eslint over src |
                            - | npm run db:migrate | apply migrations in development |
                            - | npm run db:migrate:deploy | apply migrations in production |
                            - | npm run db:seed | seed reference data |
                            - | npm run db:studio | open Prisma Studio |
                           
                            - ## Stack
                           
                            - Fastify 4 · Prisma 5 · PostgreSQL · TypeScript 5.5 (ESM) · zod · pino · pg-boss · bcryptjs · nodemailer · Cloudinary and AWS S3 · Docker · Node 22 LTS
                            - 
