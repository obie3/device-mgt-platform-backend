FROM node:22-slim AS builder
WORKDIR /app

# Install OpenSSL — required by Prisma's query engine on Debian slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn db:generate
RUN yarn build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# OpenSSL required at runtime for Prisma migrate + query engine
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Run as a non-root user — reduces blast radius if the process is compromised.
RUN groupadd -g 1001 appgroup && useradd -u 1001 -g appgroup -s /bin/sh appuser

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production
COPY --from=builder /app/dist ./dist
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
