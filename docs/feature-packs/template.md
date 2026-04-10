# Feature Pack NN: [Name]

> **How to use this template:**
> Feature packs describe *what* to build and *why*. They do NOT contain production code.
> The coding agent reads this document and implements from it. Keep code blocks to pseudocode only.

---

## Problem & Scope

[1–3 sentences. What problem does this module solve? What does it explicitly NOT do?]

**In scope:**
- [Bullet list of specific deliverables]

**Out of scope:**
- [Explicit exclusions — prevents scope creep]

---

## Depends On

| Module | What is needed |
|--------|---------------|
| 01 Foundation | DB schema (`packages/db`), shared types (`@contextos/shared`), `generateRunKey()`, `generateIdempotencyKey()` |
| [NN Name] | [Specific exported function, type, or HTTP endpoint] |

---

## Contracts

### Inputs (what this module receives)

Describe the shape of data at every entry point. Use TypeScript interface notation — no implementation.

```typescript
// HTTP request body / MCP tool input / queue job payload
interface ExampleInput {
  projectSlug: string;
  sessionId: string;
  // ...
}
```

### Outputs (what this module exposes)

List every HTTP route and MCP tool this module registers.

| Route / Tool | Method | Input | Output | Auth |
|-------------|--------|-------|--------|------|
| `GET /health` | HTTP | — | `{ status: 'ok' }` | None |
| `tool_name` | MCP | `ToolInputSchema` | `ToolOutputSchema` | Clerk Bearer |

---

## Data Changes

Reference `docs/feature-packs/00-canonical-schema.md` for column types. Do not redefine types here.

### New Tables

[List any new tables this module adds. Most modules add none — see the ownership map.]

- **`table_name`**: [one-line purpose]
  - `column_name` — type, constraints, purpose

### Modified Tables

- **`table_name`**: ADD `column_name` (type) — [why]
- **`table_name`**: ADD INDEX `index_name` on `(columns)` — [why]

---

## Algorithms

Describe decision logic in numbered pseudocode. No TypeScript syntax.

### [Algorithm Name]

```
1. Load all active policy_rules WHERE policy_id IN projectPolicies
   ORDER BY priority ASC.

2. For each rule:
   a. If rule.event_type != eventType AND rule.event_type != '*', skip.
   b. If rule.tool_pattern does not glob-match toolName, skip.
   c. If rule.path_pattern is set and does not glob-match toolInput.file_path, skip.
   d. This rule matches — return rule.decision and rule.id.

3. If no rule matched: return decision='allow', ruleId=null.

4. Write PolicyDecision record with idempotency key to prevent duplicate audit entries.
```

---

## Integration Points

### Calls out to

| Service | How | When |
|---------|-----|------|
| PostgreSQL (via `@contextos/db`) | Drizzle ORM queries | Every request |
| Redis / BullMQ | Job enqueue | On context pack save |
| NL Assembly (`NL_ASSEMBLY_URL`) | HTTP POST `/search` | On `search_packs_nl` tool call |

### Exposes to

| Consumer | What |
|----------|------|
| Claude Code / Cursor / Copilot | MCP tools over Streamable HTTP at `POST /mcp` |
| Hooks Bridge | [What the hooks bridge reads from this module] |

---

## Acceptance Criteria

Each row must be directly implementable as a Vitest test case.

| # | Scenario | Given | When | Then |
|---|----------|-------|------|------|
| 1 | Happy path | Valid project, active pack | `get_feature_pack({ projectSlug: 'my-app' })` | Returns resolved pack with `inheritanceChain` |
| 2 | Not found | Pack slug doesn't exist | `get_feature_pack({ packSlug: 'missing' })` | Returns `isError: true`, content contains `PACK_NOT_FOUND` |
| 3 | Auth failure | Missing / invalid Bearer token | Any MCP request | Returns HTTP 401 before MCP processing |
| 4 | [Add scenario] | [Given state] | [Action] | [Expected result] |

---

## File Targets

Files the coding agent should create. One-line purpose only — no content, no code.

**New files:**

- `apps/mcp-server/src/config.ts` — Zod env schema, fails fast on missing vars
- `apps/mcp-server/src/lib/db.ts` — Drizzle connection initialized from config
- `apps/mcp-server/src/tools/get-feature-pack.ts` — `get_feature_pack` MCP tool handler
- `apps/mcp-server/src/__tests__/unit/tools/get-feature-pack.test.ts` — Unit tests (mock DB)

**Modified files:**

- `apps/mcp-server/src/index.ts` — Register transport, tools, and Clerk auth middleware
- `apps/mcp-server/package.json` — Add missing runtime dependencies

---

## Known Constraints

[Any known limitations, tricky edge cases, or deliberate deferrals the agent should be aware of.]

- Inheritance cycle detection: max 10 levels, return `INHERITANCE_CYCLE` error if exceeded.
- `ON CONFLICT DO NOTHING` for all context pack inserts (append-only, no overwrites).
- `pino` logger only — no `console.log` anywhere.
