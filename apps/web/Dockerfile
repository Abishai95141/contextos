# ── Stage 1: Base ──────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app
RUN corepack enable pnpm

# ── Stage 2: Prune ─────────────────────────────────────────────────────────
FROM base AS pruner
RUN npm install -g turbo@^2
COPY . .
RUN turbo prune @contextos/web --docker

# ── Stage 3: Install dependencies ──────────────────────────────────────────
FROM base AS deps
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ── Stage 4: Build ─────────────────────────────────────────────────────────
FROM deps AS builder
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@contextos/web

# ── Stage 5: Production runner ──────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Next.js standalone output copies only required files
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "apps/web/server.js"]
