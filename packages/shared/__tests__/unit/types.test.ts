/**
 * Structural type-level tests for shared interfaces.
 *
 * These tests verify that the TypeScript interfaces exported from the shared
 * package are assignable to expected shapes.  We use runtime assertions on
 * literal objects to keep the test suite executable while also serving as
 * living documentation of the data model.
 */
import { describe, it, expect } from 'vitest';
import type {
  FeaturePack,
  FeaturePackContent,
  ArchitectureDecisionRecord,
  ToolPermission,
  FileReference,
} from '../../src/types/feature-pack.js';
import type { ContextPack, ContextPackContent, ToolTrace, Decision } from '../../src/types/context-pack.js';
import type { Run, RunEvent } from '../../src/types/run.js';
import type { Policy, PolicyRule, PolicyDecision } from '../../src/types/policy.js';

// ---------------------------------------------------------------------------
// FeaturePack
// ---------------------------------------------------------------------------

describe('FeaturePack interface', () => {
  it('accepts a minimal valid feature pack', () => {
    const pack: FeaturePack = {
      id: '1',
      projectId: 'proj-1',
      name: 'My Pack',
      version: 1,
      content: { description: 'A test pack' },
      isStale: false,
      createdAt: new Date().toISOString(),
    };
    expect(pack.id).toBe('1');
    expect(pack.version).toBe(1);
    expect(pack.isStale).toBe(false);
  });

  it('accepts a fully populated feature pack', () => {
    const adr: ArchitectureDecisionRecord = {
      id: 'adr-1',
      title: 'Use PostgreSQL',
      status: 'accepted',
      context: 'We need a relational database.',
      decision: 'Use PostgreSQL 16 with pgvector.',
      consequences: 'Great vector search support.',
    };
    const toolPerm: ToolPermission = { tool: 'bash', allowed: true, reason: 'needed for builds' };
    const ref: FileReference = { path: 'src/main.ts', description: 'Entry point', lastKnownHash: 'abc123' };

    const content: FeaturePackContent = {
      description: 'Full pack',
      architecture: 'Monorepo with turborepo',
      adrs: [adr],
      constraints: ['No circular deps'],
      toolPermissions: [toolPerm],
      testStrategy: 'Vitest unit + integration',
      references: [ref],
    };
    const pack: FeaturePack = {
      id: 'pack-1',
      projectId: 'proj-1',
      name: 'Full Pack',
      version: 3,
      parentPackId: 'parent-pack-1',
      content,
      sourceFiles: ['src/main.ts'],
      isStale: true,
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(pack.content.adrs).toHaveLength(1);
    expect(pack.content.adrs![0].status).toBe('accepted');
  });

  it('allows undefined optional fields', () => {
    const pack: FeaturePack = {
      id: '2',
      projectId: 'proj-2',
      name: 'Minimal',
      version: 1,
      content: { description: 'Minimal' },
      isStale: false,
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(pack.parentPackId).toBeUndefined();
    expect(pack.sourceFiles).toBeUndefined();
  });

  it('ADR status only accepts valid values', () => {
    const validStatuses: ArchitectureDecisionRecord['status'][] = ['accepted', 'deprecated', 'superseded'];
    validStatuses.forEach((s) => {
      expect(['accepted', 'deprecated', 'superseded']).toContain(s);
    });
  });
});

// ---------------------------------------------------------------------------
// ContextPack
// ---------------------------------------------------------------------------

describe('ContextPack interface', () => {
  it('accepts a minimal context pack', () => {
    const cp: ContextPack = {
      id: 'cp-1',
      projectId: 'proj-1',
      runId: 'run-1',
      content: { toolTraces: [], decisions: [], filesModified: [] },
      status: 'committed',
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(cp.status).toBe('committed');
  });

  it('accepts all valid status values', () => {
    const statuses: ContextPack['status'][] = ['committed', 'partial', 'quarantined'];
    statuses.forEach((s) => {
      expect(['committed', 'partial', 'quarantined']).toContain(s);
    });
  });

  it('accepts a tool trace with all fields', () => {
    const trace: ToolTrace = {
      toolName: 'bash',
      inputs: { command: 'echo hello' },
      outputs: { stdout: 'hello', exitCode: 0 },
      durationMs: 42,
      timestamp: '2024-01-01T00:00:00Z',
    };
    const content: ContextPackContent = {
      toolTraces: [trace],
      decisions: [],
      filesModified: ['src/main.ts'],
    };
    expect(content.toolTraces[0].toolName).toBe('bash');
    expect(content.toolTraces[0].durationMs).toBe(42);
  });

  it('accepts a decision with and without alternatives', () => {
    const withAlts: Decision = {
      description: 'Use Redis for caching',
      rationale: 'Low latency',
      alternatives: ['Memcached', 'In-memory map'],
      timestamp: '2024-01-01T00:00:00Z',
    };
    const withoutAlts: Decision = {
      description: 'Use TypeScript',
      rationale: 'Type safety',
      timestamp: '2024-01-01T00:00:00Z',
    };
    expect(withAlts.alternatives).toHaveLength(2);
    expect(withoutAlts.alternatives).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

describe('Run interface', () => {
  it('accepts a run in progress', () => {
    const run: Run = {
      id: 'run-1',
      projectId: 'proj-1',
      sessionId: 'ses-1',
      idempotencyKey: 'run:proj-1:ses-1:uuid',
      status: 'in_progress',
      startedAt: '2024-01-01T00:00:00Z',
    };
    expect(run.status).toBe('in_progress');
    expect(run.completedAt).toBeUndefined();
  });

  it('accepts a completed run', () => {
    const run: Run = {
      id: 'run-2',
      projectId: 'proj-1',
      sessionId: 'ses-2',
      idempotencyKey: 'run:proj-1:ses-2:uuid',
      status: 'completed',
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-01T01:00:00Z',
    };
    expect(run.completedAt).toBe('2024-01-01T01:00:00Z');
  });

  it('accepts a RunEvent with all fields', () => {
    const event: RunEvent = {
      id: 'evt-1',
      runId: 'run-1',
      eventType: 'tool_use',
      toolName: 'read',
      inputs: { path: 'src/index.ts' },
      outputs: { content: '...' },
      durationMs: 5,
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(event.eventType).toBe('tool_use');
  });

  it('RunEvent eventType only accepts valid values', () => {
    const types: RunEvent['eventType'][] = ['tool_use', 'policy_check', 'decision'];
    types.forEach((t) => {
      expect(['tool_use', 'policy_check', 'decision']).toContain(t);
    });
  });
});

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

describe('Policy interface', () => {
  it('accepts a policy with rules', () => {
    const rule: PolicyRule = {
      tool: 'bash',
      action: 'block',
      conditions: [{ field: 'command', operator: 'contains', value: 'rm -rf' }],
      reason: 'Destructive command',
    };
    const policy: Policy = {
      id: 'pol-1',
      projectId: 'proj-1',
      name: 'No destructive commands',
      rules: [rule],
      isActive: true,
      createdAt: '2024-01-01T00:00:00Z',
    };
    expect(policy.rules[0].action).toBe('block');
  });

  it('accepts all valid PolicyRule action values', () => {
    const actions: PolicyRule['action'][] = ['allow', 'block', 'warn'];
    actions.forEach((a) => {
      expect(['allow', 'block', 'warn']).toContain(a);
    });
  });

  it('accepts a PolicyDecision', () => {
    const decision: PolicyDecision = {
      policyId: 'pol-1',
      toolName: 'write',
      decision: 'allow',
      reason: 'Passes all rules',
    };
    expect(decision.decision).toBe('allow');
  });

  it('accepts all valid PolicyDecision decision values', () => {
    const decisions: PolicyDecision['decision'][] = ['allow', 'block', 'warn'];
    decisions.forEach((d) => {
      expect(['allow', 'block', 'warn']).toContain(d);
    });
  });
});
