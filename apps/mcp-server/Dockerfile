# ── Stage 1: Base ──────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app
RUN corepack enable pnpm

# ── Stage 2: Prune (isolate the workspace for this app) ────────────────────
FROM base AS pruner
RUN npm install -g turbo@^2
COPY . .
RUN turbo prune @contextos/mcp-server --docker

# ── Stage 3: Install dependencies ──────────────────────────────────────────
FROM base AS deps
# Copy the pruned lockfile + package manifests
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ── Stage 4: Build ─────────────────────────────────────────────────────────
FROM deps AS builder
# Copy the full pruned source tree
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@contextos/mcp-server

# ── Stage 5: Production runner ──────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

# Copy built artifacts and runtime dependencies
COPY --from=builder --chown=app:app /app/apps/mcp-server/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/apps/mcp-server/package.json ./

USER app

ENV NODE_ENV=production

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3100/health || exit 1

CMD ["node", "dist/index.js"]
