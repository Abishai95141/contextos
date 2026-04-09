/**
 * Integration tests — Database schema migration.
 *
 * Uses @testcontainers/postgresql to spin up a real pgvector-enabled
 * PostgreSQL 16 container, run the initial migration SQL, and verify
 * that the Drizzle schema matches the live database.
 *
 * Requirements:
 *   - Docker daemon running on the test host
 *   - @testcontainers/postgresql installed (see package.json devDeps)
 *
 * Environment override:
 *   - Set DATABASE_URL to skip the testcontainer and use an existing DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Testcontainer helpers
// ---------------------------------------------------------------------------

type ContainerHandle = {
  connectionString: string;
  stop: () => Promise<void>;
};

async function startPostgres(): Promise<ContainerHandle> {
  const externalUrl = process.env['DATABASE_URL'];
  if (externalUrl) {
    return { connectionString: externalUrl, stop: async () => undefined };
  }

  // Lazy-import testcontainers so the test file can still be imported without
  // the package installed (it will simply be skipped).
  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
      .withDatabase('contextos_test')
      .withUsername('contextos')
      .withPassword('contextos_test')
      .start();

    return {
      connectionString: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    throw new Error(
      'Could not start Postgres container. Ensure Docker is running or set DATABASE_URL. ' +
        `Original error: ${err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let sql: ReturnType<typeof postgres> | undefined;
let handle: ContainerHandle | undefined;

beforeAll(async () => {
  handle = await startPostgres();
  sql = postgres(handle.connectionString, { max: 5 });

  // Run the initial migration
  const migrationPath = join(__dirname, '../../drizzle/0000_initial.sql');
  const migrationSql = readFileSync(migrationPath, 'utf-8');
  await sql.unsafe(migrationSql);
}, 120_000); // containers can take up to 2 minutes to pull on cold start

afterAll(async () => {
  await sql?.end();
  await handle?.stop();
});

// ---------------------------------------------------------------------------
// Schema shape tests
// ---------------------------------------------------------------------------

describe('Initial schema migration', () => {
  it('creates the projects table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'projects'
    `;
    expect(rows.length).toBe(1);
  });

  it('creates the users table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    `;
    expect(rows.length).toBe(1);
  });

  it('creates the project_members table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'project_members'
    `;
    expect(rows.length).toBe(1);
  });

  it('creates the feature_packs table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'feature_packs'
    `;
    expect(rows.length).toBe(1);
  });

  it('creates the context_packs table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'context_packs'
    `;
    expect(rows.length).toBe(1);
  });

  it('creates the runs table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'runs'
    `;
    expect(rows.length).toBe(1);
  });

  it('creates the run_events table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'run_events'
    `;
    expect(rows.length).toBe(1);
  });

  it('creates the policies table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'policies'
    `;
    expect(rows.length).toBe(1);
  });

  it('creates the policy_decisions table', async () => {
    const rows = await sql!`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'policy_decisions'
    `;
    expect(rows.length).toBe(1);
  });

  it('enables the pgvector extension', async () => {
    const rows = await sql!`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `;
    expect(rows.length).toBe(1);
  });

  it('context_packs.summary_embedding column has vector type', async () => {
    const rows = await sql!`
      SELECT column_name, udt_name
      FROM information_schema.columns
      WHERE table_name = 'context_packs' AND column_name = 'summary_embedding'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!['udt_name']).toBe('vector');
  });
});

// ---------------------------------------------------------------------------
// Data operations
// ---------------------------------------------------------------------------

describe('Data operations', () => {
  it('can insert a project and retrieve it', async () => {
    await sql!`
      INSERT INTO projects (name, slug) VALUES ('Test Project', 'test-project')
    `;
    const rows = await sql!`SELECT * FROM projects WHERE slug = 'test-project'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!['name']).toBe('Test Project');
  });

  it('enforces unique slug constraint on projects', async () => {
    await sql!`INSERT INTO projects (name, slug) VALUES ('Dup', 'unique-slug')`;
    await expect(
      sql!`INSERT INTO projects (name, slug) VALUES ('Dup 2', 'unique-slug')`,
    ).rejects.toThrow();
  });

  it('can insert a user and retrieve it', async () => {
    await sql!`
      INSERT INTO users (external_id, email, name)
      VALUES ('clerk-user-1', 'alice@example.com', 'Alice')
    `;
    const rows = await sql!`SELECT * FROM users WHERE external_id = 'clerk-user-1'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!['email']).toBe('alice@example.com');
  });

  it('users.external_id is unique', async () => {
    await sql!`INSERT INTO users (external_id, email) VALUES ('clerk-dup', 'dup@example.com')`;
    await expect(
      sql!`INSERT INTO users (external_id, email) VALUES ('clerk-dup', 'dup2@example.com')`,
    ).rejects.toThrow();
  });

  it('can insert a run with idempotency key', async () => {
    // Need a project first
    const [proj] = await sql!`
      INSERT INTO projects (name, slug) VALUES ('Run Test', 'run-test') RETURNING id
    `;
    await sql!`
      INSERT INTO runs (project_id, session_id, idempotency_key)
      VALUES (${proj!['id']}, 'ses-1', 'idem-key-1')
    `;
    const rows = await sql!`SELECT * FROM runs WHERE idempotency_key = 'idem-key-1'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!['status']).toBe('in_progress');
  });

  it('run idempotency_key is unique', async () => {
    const [proj] = await sql!`
      INSERT INTO projects (name, slug) VALUES ('Run Dup', 'run-dup') RETURNING id
    `;
    await sql!`
      INSERT INTO runs (project_id, session_id, idempotency_key)
      VALUES (${proj!['id']}, 'ses-x', 'idem-key-dup')
    `;
    await expect(
      sql!`
        INSERT INTO runs (project_id, session_id, idempotency_key)
        VALUES (${proj!['id']}, 'ses-y', 'idem-key-dup')
      `,
    ).rejects.toThrow();
  });

  it('feature_packs default version is 1', async () => {
    const [proj] = await sql!`
      INSERT INTO projects (name, slug) VALUES ('FP Test', 'fp-test') RETURNING id
    `;
    await sql!`
      INSERT INTO feature_packs (project_id, name, content)
      VALUES (${proj!['id']}, 'My Pack', '{"description":"test"}'::jsonb)
    `;
    const rows = await sql!`SELECT * FROM feature_packs WHERE name = 'My Pack'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!['version']).toBe(1);
  });

  it('context_packs default status is "committed"', async () => {
    const [proj] = await sql!`
      INSERT INTO projects (name, slug) VALUES ('CP Test', 'cp-test') RETURNING id
    `;
    const runId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    await sql!`
      INSERT INTO context_packs (project_id, run_id, content)
      VALUES (${proj!['id']}, ${runId}::uuid, '{"toolTraces":[],"decisions":[],"filesModified":[]}'::jsonb)
    `;
    const rows = await sql!`SELECT * FROM context_packs WHERE project_id = ${proj!['id']}`;
    expect(rows[0]!['status']).toBe('committed');
  });
});

// ---------------------------------------------------------------------------
// Index existence
// ---------------------------------------------------------------------------

describe('Indexes', () => {
  const indexCases = [
    'feature_packs_project_idx',
    'feature_packs_parent_idx',
    'context_packs_project_idx',
    'context_packs_run_idx',
    'context_packs_issue_idx',
    'context_packs_status_idx',
    'runs_project_idx',
    'runs_session_idx',
  ];

  for (const indexName of indexCases) {
    it(`has index ${indexName}`, async () => {
      const rows = await sql!`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = ${indexName}
      `;
      expect(rows.length, `Index ${indexName} should exist`).toBe(1);
    });
  }
});
