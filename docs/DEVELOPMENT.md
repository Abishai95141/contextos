# ContextOS — Development Guide

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 22 | [nodejs.org](https://nodejs.org/) or `nvm install 22` |
| pnpm | ≥ 9 | `corepack enable pnpm` (bundled with Node 22) |
| Docker | ≥ 24 | [docker.com](https://docs.docker.com/get-docker/) |
| uv | latest | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Python | 3.12 | Managed by uv — `uv python install 3.12` |

---

## Initial Setup

### 1. Clone and Install

```bash
git clone git@github.com:Abishai95141/contextos.git
cd contextos

# Install TypeScript dependencies
pnpm install

# Copy environment config
cp .env.example .env
# Edit .env with your local values (database URL, API keys, etc.)
```

### 2. Start Infrastructure

```bash
# Start PostgreSQL (pgvector) + Redis
docker compose up -d

# Verify services are running
docker compose ps
# postgres   running   0.0.0.0:5432->5432/tcp
# redis      running   0.0.0.0:6379->6379/tcp
```

### 3. Run Database Migrations

```bash
pnpm db:migrate
```

### 4. Build All Packages

```bash
pnpm build
```

### 5. Set Up Python Services

```bash
# NL Assembly
cd services/nl-assembly
uv sync
cd ../..

# Semantic Diff
cd services/semantic-diff
uv sync
cd ../..
```

### 6. Verify Everything Works

```bash
# Type check
pnpm typecheck

# Lint
pnpm lint

# Unit tests
pnpm test:unit

# Integration tests (requires Docker running)
pnpm test:integration
```

---

## Running Services Locally

### MCP Server

```bash
pnpm --filter @contextos/mcp-server dev
# Runs on http://localhost:3100
# Health check: http://localhost:3100/health
```

### Hooks Bridge

```bash
pnpm --filter @contextos/hooks-bridge dev
# Runs on http://localhost:3101
# Health check: http://localhost:3101/health
```

### Web App

```bash
pnpm --filter @contextos/web dev
# Runs on http://localhost:3000
```

### NL Assembly (Python)

```bash
cd services/nl-assembly
uv run uvicorn src.main:app --reload --port 3200
# Runs on http://localhost:3200
# Health check: http://localhost:3200/health
# Docs: http://localhost:3200/docs (Swagger UI)
```

### Semantic Diff (Python)

```bash
cd services/semantic-diff
uv run uvicorn src.main:app --reload --port 3201
# Runs on http://localhost:3201
# Health check: http://localhost:3201/health
# Docs: http://localhost:3201/docs (Swagger UI)
```

### Run Everything (dev mode)

```bash
# TypeScript services (via Turborepo)
pnpm dev

# Python services (in separate terminals)
cd services/nl-assembly && uv run uvicorn src.main:app --reload --port 3200
cd services/semantic-diff && uv run uvicorn src.main:app --reload --port 3201
```

---

## Development Workflow

### 1. Create a Feature Branch

```bash
git checkout main
git pull origin main
git checkout -b feat/02-mcp-server-get-feature-pack
```

### 2. Read the Feature Pack Spec

Before writing any code, read the relevant feature pack documentation:

```bash
# For MCP Server work:
cat docs/feature-packs/02-mcp-server/spec.md
cat docs/feature-packs/02-mcp-server/implementation.md
cat docs/feature-packs/02-mcp-server/techstack.md
```

### 3. Implement

Follow the step-by-step plan in `implementation.md`. Write code, write tests, verify.

### 4. Verify Locally

```bash
# Must all pass before pushing:
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
```

### 5. Commit and Push

```bash
git add .
git commit -m "feat: implement get_feature_pack MCP tool with freshness checking"
git push origin feat/02-mcp-server-get-feature-pack
```

### 6. Open a Pull Request

PRs to `main` trigger the CI pipeline automatically:
- Lint + Typecheck
- Unit Tests
- Integration Tests
- Python Tests

### 7. Save a Context Pack

After merging, document what was built:

```bash
cp docs/context-packs/template.md docs/context-packs/$(date +%Y-%m-%d)-feature-name.md
# Edit the file with details of what was built
```

---

## Running Tests

### Unit Tests (fast, no Docker needed)

```bash
# All packages
pnpm test:unit

# Specific package
pnpm --filter @contextos/mcp-server test:unit

# Watch mode (re-runs on file change)
pnpm --filter @contextos/mcp-server test:unit -- --watch

# With coverage
pnpm --filter @contextos/mcp-server test:unit -- --coverage
```

### Integration Tests (requires Docker)

```bash
# Start infrastructure first
docker compose up -d

# Run integration tests (uses testcontainers for isolated DB)
pnpm test:integration

# Specific package
pnpm --filter @contextos/hooks-bridge test:integration
```

### E2E Tests (full stack)

```bash
# Requires all services running
docker compose up -d
pnpm test:e2e
```

### Python Tests

```bash
# NL Assembly
cd services/nl-assembly
uv run pytest tests/ -v

# Semantic Diff
cd services/semantic-diff
uv run pytest tests/ -v

# With coverage
uv run pytest tests/ -v --cov=src --cov-report=term-missing
```

---

## Database Operations

### Generate a New Migration

After modifying `packages/db/src/schema.ts`:

```bash
pnpm db:generate
# Creates a new SQL file in packages/db/drizzle/
```

### Run Migrations

```bash
pnpm db:migrate
```

### Reset the Database (development only)

```bash
docker compose down -v  # Destroys data volume
docker compose up -d
pnpm db:migrate
```

### Connect to the Database

```bash
docker compose exec postgres psql -U contextos -d contextos
```

### Inspect pgvector

```sql
-- Check extension is installed
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Check index type on embeddings
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'context_packs';
```

---

## Docker Operations

### Build a Service Image

```bash
# MCP Server
docker build -f apps/mcp-server/Dockerfile -t contextos/mcp-server .

# Hooks Bridge
docker build -f apps/hooks-bridge/Dockerfile -t contextos/hooks-bridge .

# Web App
docker build -f apps/web/Dockerfile -t contextos/web .

# NL Assembly
docker build -f services/nl-assembly/Dockerfile -t contextos/nl-assembly services/nl-assembly/

# Semantic Diff
docker build -f services/semantic-diff/Dockerfile -t contextos/semantic-diff services/semantic-diff/
```

### Run a Service Container

```bash
docker run --rm -p 3100:3100 \
  -e DATABASE_URL=postgresql://contextos:contextos_dev@host.docker.internal:5432/contextos \
  -e CLERK_SECRET_KEY=your_key \
  contextos/mcp-server
```

---

## Troubleshooting

### pnpm install fails

```bash
# Ensure correct Node version
node -v  # Must be ≥ 22

# Clear cache and retry
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

### Typecheck fails after pulling

```bash
# Rebuild all packages (typecheck depends on built types)
pnpm build
pnpm typecheck
```

### Integration tests fail — Docker not running

```bash
docker compose ps
# If nothing shows, start it:
docker compose up -d
```

### pgvector extension not found

Ensure you are using the `pgvector/pgvector:pg16` image, not plain `postgres:16`:

```bash
docker compose down -v
docker compose up -d
pnpm db:migrate
```

### Python service — ModuleNotFoundError

```bash
cd services/nl-assembly  # or semantic-diff
uv sync  # Re-install dependencies
```

### Port conflicts

```bash
# Check what's using a port
lsof -i :3100

# Kill a process on a port
kill -9 $(lsof -t -i :3100)
```

### Logs are hard to read

Use pino-pretty for human-readable logs in development:

```bash
pnpm --filter @contextos/mcp-server dev | npx pino-pretty
```
