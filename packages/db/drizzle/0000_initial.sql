CREATE TABLE "context_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_ref" text,
	"feature_pack_id" uuid,
	"feature_pack_version" integer,
	"content" jsonb NOT NULL,
	"semantic_diff" jsonb,
	"summary" text,
	"summary_embedding" vector(384),
	"status" text DEFAULT 'committed' NOT NULL,
	"agent_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_pack_id" uuid,
	"content" jsonb NOT NULL,
	"source_files" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_stale" boolean DEFAULT false,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"version_lock" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"rule_id" uuid,
	"run_id" uuid,
	"session_id" text,
	"tool_name" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"evaluated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "policy_decisions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "policy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"name" text NOT NULL,
	"event_type" text NOT NULL,
	"tool_pattern" text NOT NULL,
	"path_pattern" text,
	"decision" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"repo_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"tool_name" text,
	"inputs" jsonb,
	"outputs" jsonb,
	"duration_ms" integer,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"feature_pack_id" uuid,
	"issue_ref" text,
	"agent_name" text,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_packs" ADD CONSTRAINT "context_packs_feature_pack_id_feature_packs_id_fk" FOREIGN KEY ("feature_pack_id") REFERENCES "public"."feature_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_packs" ADD CONSTRAINT "feature_packs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_rule_id_policy_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."policy_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_policy_id_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_feature_pack_id_feature_packs_id_fk" FOREIGN KEY ("feature_pack_id") REFERENCES "public"."feature_packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_packs_project_idx" ON "context_packs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "context_packs_run_idx" ON "context_packs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "context_packs_issue_idx" ON "context_packs" USING btree ("issue_ref");--> statement-breakpoint
CREATE INDEX "context_packs_status_idx" ON "context_packs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "context_packs_embedding_hnsw_idx" ON "context_packs" USING hnsw ("summary_embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "feature_packs_project_idx" ON "feature_packs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "feature_packs_parent_idx" ON "feature_packs" USING btree ("parent_pack_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_packs_project_slug_version_idx" ON "feature_packs" USING btree ("project_id","slug","version");--> statement-breakpoint
CREATE INDEX "policies_project_idx" ON "policies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "policy_decisions_policy_idx" ON "policy_decisions" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "policy_decisions_run_idx" ON "policy_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "policy_rules_policy_priority_idx" ON "policy_rules" USING btree ("policy_id","priority");--> statement-breakpoint
CREATE INDEX "projects_clerk_org_idx" ON "projects" USING btree ("clerk_org_id");--> statement-breakpoint
CREATE INDEX "run_events_run_idx" ON "run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_project_idx" ON "runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "runs_session_idx" ON "runs" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_idx" ON "runs" USING btree ("idempotency_key");