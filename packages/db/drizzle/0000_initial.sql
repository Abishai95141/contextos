-- ContextOS Initial Schema
-- Requires: CREATE EXTENSION IF NOT EXISTS vector;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Projects
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  repo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  external_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Project Members
CREATE TABLE project_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

-- Feature Packs
CREATE TABLE feature_packs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  parent_pack_id UUID,
  content JSONB NOT NULL,
  source_files JSONB,
  is_stale BOOLEAN DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version_lock INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX feature_packs_project_idx ON feature_packs(project_id);
CREATE INDEX feature_packs_parent_idx ON feature_packs(parent_pack_id);

-- Context Packs (append-only)
CREATE TABLE context_packs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id),
  run_id UUID NOT NULL,
  issue_ref TEXT,
  feature_pack_id UUID REFERENCES feature_packs(id),
  feature_pack_version INTEGER,
  content JSONB NOT NULL,
  semantic_diff JSONB,
  summary TEXT,
  summary_embedding vector(1536),
  status TEXT NOT NULL DEFAULT 'committed',
  agent_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX context_packs_project_idx ON context_packs(project_id);
CREATE INDEX context_packs_run_idx ON context_packs(run_id);
CREATE INDEX context_packs_issue_idx ON context_packs(issue_ref);
CREATE INDEX context_packs_status_idx ON context_packs(status);

-- Runs
CREATE TABLE runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id),
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  feature_pack_id UUID REFERENCES feature_packs(id),
  issue_ref TEXT,
  agent_name TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX runs_project_idx ON runs(project_id);
CREATE INDEX runs_session_idx ON runs(session_id);

-- Run Events (append-only)
CREATE TABLE run_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES runs(id),
  event_type TEXT NOT NULL,
  tool_name TEXT,
  inputs JSONB,
  outputs JSONB,
  duration_ms INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX run_events_run_idx ON run_events(run_id);

-- Policies
CREATE TABLE policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT,
  rules JSONB NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX policies_project_idx ON policies(project_id);

-- Policy Decisions (audit log)
CREATE TABLE policy_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  policy_id UUID NOT NULL REFERENCES policies(id),
  run_id UUID REFERENCES runs(id),
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX policy_decisions_policy_idx ON policy_decisions(policy_id);
CREATE INDEX policy_decisions_run_idx ON policy_decisions(run_id);
