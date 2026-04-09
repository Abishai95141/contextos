import { pgTable, uuid, text, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

// ── Projects ──
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  repoUrl: text("repo_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Users ──
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  externalId: text("external_id").notNull().unique(), // Clerk user ID
  email: text("email").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Project Members ──
export const projectMembers = pgTable("project_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: text("role").notNull().default("member"), // owner | admin | member
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  uniqueMember: uniqueIndex("unique_project_member").on(table.projectId, table.userId),
}));

// ── Feature Packs ──
export const featurePacks = pgTable("feature_packs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  parentPackId: uuid("parent_pack_id"), // inheritance
  content: jsonb("content").notNull(), // structured pack content
  sourceFiles: jsonb("source_files").$type<string[]>(), // referenced files for freshness
  isStale: boolean("is_stale").default(false),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  versionLock: integer("version_lock").notNull().default(0), // optimistic locking
}, (table) => ({
  projectIdx: index("feature_packs_project_idx").on(table.projectId),
  parentIdx: index("feature_packs_parent_idx").on(table.parentPackId),
}));

// ── Context Packs (append-only) ──
export const contextPacks = pgTable("context_packs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  runId: uuid("run_id").notNull(),
  issueRef: text("issue_ref"), // e.g., "PROJ-123"
  featurePackId: uuid("feature_pack_id").references(() => featurePacks.id),
  featurePackVersion: integer("feature_pack_version"),
  content: jsonb("content").notNull(), // assembled context pack
  semanticDiff: jsonb("semantic_diff"), // structured diff summary
  summary: text("summary"), // human-readable summary
  summaryEmbedding: text("summary_embedding"), // pgvector (stored as text, cast in queries)
  status: text("status").notNull().default("committed"), // committed | partial | quarantined
  agentName: text("agent_name"), // claude-code | cursor | copilot
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  projectIdx: index("context_packs_project_idx").on(table.projectId),
  runIdx: index("context_packs_run_idx").on(table.runId),
  issueIdx: index("context_packs_issue_idx").on(table.issueRef),
  statusIdx: index("context_packs_status_idx").on(table.status),
}));

// ── Runs ──
export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  sessionId: text("session_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  featurePackId: uuid("feature_pack_id").references(() => featurePacks.id),
  issueRef: text("issue_ref"),
  agentName: text("agent_name"),
  status: text("status").notNull().default("in_progress"), // in_progress | completed | interrupted
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  projectIdx: index("runs_project_idx").on(table.projectId),
  sessionIdx: index("runs_session_idx").on(table.sessionId),
  idempotencyIdx: uniqueIndex("runs_idempotency_idx").on(table.idempotencyKey),
}));

// ── Run Events (append-only tool traces) ──
export const runEvents = pgTable("run_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  eventType: text("event_type").notNull(), // tool_use | policy_check | decision
  toolName: text("tool_name"),
  inputs: jsonb("inputs"),
  outputs: jsonb("outputs"),
  durationMs: integer("duration_ms"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  runIdx: index("run_events_run_idx").on(table.runId),
}));

// ── Policies ──
export const policies = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  name: text("name").notNull(),
  description: text("description"),
  rules: jsonb("rules").notNull(), // policy rule definitions
  isActive: boolean("is_active").default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  projectIdx: index("policies_project_idx").on(table.projectId),
}));

// ── Policy Decisions (audit log) ──
export const policyDecisions = pgTable("policy_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyId: uuid("policy_id").notNull().references(() => policies.id),
  runId: uuid("run_id").references(() => runs.id),
  toolName: text("tool_name").notNull(),
  decision: text("decision").notNull(), // allow | block | warn
  reason: text("reason"),
  evaluatedAt: timestamp("evaluated_at").defaultNow().notNull(),
}, (table) => ({
  policyIdx: index("policy_decisions_policy_idx").on(table.policyId),
  runIdx: index("policy_decisions_run_idx").on(table.runId),
}));
