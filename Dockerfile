FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install
COPY . .
RUN yarn run db:generate
RUN yarn run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Run as a non-root user — reduces blast radius if the process is compromised.
RUN addgroup -g 1001 -S appgroup && \
    adduser  -u 1001 -S appuser -G appgroup

COPY package.json yarn.lock ./
RUN yarn install --production

COPY --from=builder /app/dist            ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

# Transfer ownership so the non-root user can write to working dir if needed
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

# Run migrations before starting the server. This ensures the DB schema is
# always up to date on container start (safe for rolling deployments because
# `migrate deploy` is idempotent and only applies pending migrations).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
