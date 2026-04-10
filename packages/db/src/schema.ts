import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// ── Projects ──
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkOrgId: text('clerk_org_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    repoUrl: text('repo_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    clerkOrgIdx: index('projects_clerk_org_idx').on(table.clerkOrgId),
  }),
);

// ── Feature Packs ──
export const featurePacks = pgTable(
  'feature_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    version: integer('version').notNull().default(1),
    parentPackId: uuid('parent_pack_id'), // self-referential, no FK constraint to avoid cycle issues
    content: jsonb('content').notNull(),
    sourceFiles: jsonb('source_files').$type<string[]>(),
    isActive: boolean('is_active').notNull().default(true),
    isStale: boolean('is_stale').default(false),
    createdBy: text('created_by'), // Clerk user ID string
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    versionLock: integer('version_lock').notNull().default(0),
  },
  (table) => ({
    projectIdx: index('feature_packs_project_idx').on(table.projectId),
    parentIdx: index('feature_packs_parent_idx').on(table.parentPackId),
    slugVersionUnique: uniqueIndex('feature_packs_project_slug_version_idx').on(
      table.projectId,
      table.slug,
      table.version,
    ),
  }),
);

// ── Runs ──
// Defined before context_packs and run_events so FK references resolve.
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    sessionId: text('session_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    featurePackId: uuid('feature_pack_id').references(() => featurePacks.id),
    issueRef: text('issue_ref'),
    agentName: text('agent_name'),
    status: text('status').notNull().default('in_progress'), // in_progress | completed | interrupted
    startedAt: timestamp('started_at').defaultNow().notNull(),
    completedAt: timestamp('completed_at'),
  },
  (table) => ({
    projectIdx: index('runs_project_idx').on(table.projectId),
    sessionIdx: index('runs_session_idx').on(table.sessionId),
    idempotencyIdx: uniqueIndex('runs_idempotency_idx').on(table.idempotencyKey),
  }),
);

// ── Context Packs (append-only) ──
export const contextPacks = pgTable(
  'context_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    issueRef: text('issue_ref'),
    featurePackId: uuid('feature_pack_id').references(() => featurePacks.id),
    featurePackVersion: integer('feature_pack_version'),
    content: jsonb('content').notNull(),
    semanticDiff: jsonb('semantic_diff'),
    summary: text('summary'),
    summaryEmbedding: vector('summary_embedding', { dimensions: 384 }),
    status: text('status').notNull().default('committed'), // committed | partial | quarantined
    agentName: text('agent_name'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('context_packs_project_idx').on(table.projectId),
    runIdx: index('context_packs_run_idx').on(table.runId),
    issueIdx: index('context_packs_issue_idx').on(table.issueRef),
    statusIdx: index('context_packs_status_idx').on(table.status),
    embeddingIdx: index('context_packs_embedding_hnsw_idx').using(
      'hnsw',
      table.summaryEmbedding.op('vector_cosine_ops'),
    ),
  }),
);

// ── Run Events (append-only tool traces) ──
export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    eventType: text('event_type').notNull(), // tool_use | policy_check | decision
    toolName: text('tool_name'),
    inputs: jsonb('inputs'),
    outputs: jsonb('outputs'),
    durationMs: integer('duration_ms'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    runIdx: index('run_events_run_idx').on(table.runId),
  }),
);

// ── Policies ──
export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: text('created_by'), // Clerk user ID string
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('policies_project_idx').on(table.projectId),
  }),
);

// ── Policy Rules ──
// Individual rules within a policy. Evaluated in priority order (lower number = higher priority).
export const policyRules = pgTable(
  'policy_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id),
    name: text('name').notNull(),
    eventType: text('event_type').notNull(), // PreToolUse | PostToolUse | PermissionRequest | *
    toolPattern: text('tool_pattern').notNull(), // glob, e.g. "Bash", "Write*", "*"
    pathPattern: text('path_pattern'), // glob, e.g. "**/node_modules/**" — nullable
    decision: text('decision').notNull(), // allow | deny | warn
    priority: integer('priority').notNull().default(100), // lower = higher priority
    isActive: boolean('is_active').notNull().default(true),
    metadata: jsonb('metadata'), // extra conditions or annotations
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    policyPriorityIdx: index('policy_rules_policy_priority_idx').on(table.policyId, table.priority),
  }),
);

// ── Policy Decisions (append-only audit log) ──
export const policyDecisions = pgTable(
  'policy_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id),
    ruleId: uuid('rule_id').references(() => policyRules.id), // which rule matched; null = default allow
    runId: uuid('run_id').references(() => runs.id),
    sessionId: text('session_id'), // for hook traces before a run is created
    toolName: text('tool_name').notNull(),
    decision: text('decision').notNull(), // allow | deny | warn
    reason: text('reason'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    evaluatedAt: timestamp('evaluated_at').defaultNow().notNull(),
  },
  (table) => ({
    policyIdx: index('policy_decisions_policy_idx').on(table.policyId),
    runIdx: index('policy_decisions_run_idx').on(table.runId),
  }),
);
