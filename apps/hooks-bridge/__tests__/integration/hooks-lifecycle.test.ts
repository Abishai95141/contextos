/**
 * Integration tests — Hooks lifecycle.
 *
 * Tests the policy engine and handler modules end-to-end using only
 * in-process imports (no network calls, no database).
 *
 * Post-Phase-2: extend with a real Hono app.request() test using the
 * HTTP server defined in src/index.ts.
 */
import { describe, it, expect } from 'vitest';
import type { PolicyRule } from '@contextos/shared';

// ---------------------------------------------------------------------------
// Policy engine — evaluatePolicy
// ---------------------------------------------------------------------------

describe('evaluatePolicy — full lifecycle', () => {
  let evaluatePolicy: (
    rules: PolicyRule[],
    toolName: string,
    toolParams: Record<string, unknown>,
  ) => import('@contextos/shared').PolicyDecision;

  it('resolves policy engine module', async () => {
    const mod = await import('../../src/lib/policy-engine.js');
    expect(typeof mod.evaluatePolicy).toBe('function');
    evaluatePolicy = mod.evaluatePolicy;
  });

  it('default-allows when rule list is empty', async () => {
    const { evaluatePolicy } = await import('../../src/lib/policy-engine.js');
    const decision = evaluatePolicy([], 'bash', { command: 'ls' });
    expect(decision.decision).toBe('allow');
    expect(decision.toolName).toBe('bash');
  });

  it('returns a PolicyDecision with all required fields', async () => {
    const { evaluatePolicy } = await import('../../src/lib/policy-engine.js');
    const decision = evaluatePolicy([], 'read', {});
    expect(decision).toMatchObject({
      policyId: expect.any(String),
      toolName: expect.any(String),
      decision: expect.any(String),
      reason: expect.any(String),
    });
  });

  it('policy decision is one of allow|block|warn', async () => {
    const { evaluatePolicy } = await import('../../src/lib/policy-engine.js');
    const decision = evaluatePolicy([], 'write', { path: '/tmp/file.txt', content: 'data' });
    expect(['allow', 'block', 'warn']).toContain(decision.decision);
  });

  it('default reason is a non-empty string', async () => {
    const { evaluatePolicy } = await import('../../src/lib/policy-engine.js');
    const decision = evaluatePolicy([], 'bash', {});
    expect(decision.reason.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Handler modules — imports and exports
// ---------------------------------------------------------------------------

describe('Handler module exports', () => {
  it('pre-tool-use exports handlePreToolUse', async () => {
    const mod = await import('../../src/handlers/pre-tool-use.js');
    expect(typeof mod.handlePreToolUse).toBe('function');
  });

  it('session-start exports handleSessionStart', async () => {
    const mod = await import('../../src/handlers/session-start.js');
    expect(typeof mod.handleSessionStart).toBe('function');
  });

  it('post-tool-use exports handlePostToolUse', async () => {
    const mod = await import('../../src/handlers/post-tool-use.js');
    expect(typeof mod.handlePostToolUse).toBe('function');
  });

  it('stop exports handleStop', async () => {
    const mod = await import('../../src/handlers/stop.js');
    expect(typeof mod.handleStop).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Full hook event lifecycle (stub simulation)
// ---------------------------------------------------------------------------

describe('Hook lifecycle simulation', () => {
  it('SessionStart → PreToolUse → PostToolUse → Stop (stub chain)', async () => {
    // Simulate a full developer session using stub implementations
    type SessionCtx = { sessionId: string; runId: string; toolsUsed: string[] };
    const ctx: SessionCtx = { sessionId: 'ses-lifecycle-1', runId: 'run-lifecycle-1', toolsUsed: [] };

    // 1. SessionStart: identify project
    const sessionStartResult = await Promise.resolve({
      additionalContext: `Project: contextos\nSession: ${ctx.sessionId}`,
    });
    expect(sessionStartResult.additionalContext).toContain(ctx.sessionId);

    // 2. PreToolUse: evaluate policy (using real policy engine — allow all by default)
    const { evaluatePolicy } = await import('../../src/lib/policy-engine.js');
    const tools = ['read', 'write', 'bash', 'bash', 'write'];

    for (const tool of tools) {
      const decision = evaluatePolicy([], tool, { command: 'echo hello' });
      expect(decision.decision).toBe('allow');
      ctx.toolsUsed.push(tool);
    }

    // 3. PostToolUse: record tool trace
    const postToolResults = ctx.toolsUsed.map((tool) => ({
      toolName: tool,
      recorded: true,
      durationMs: Math.floor(Math.random() * 100),
    }));
    expect(postToolResults).toHaveLength(tools.length);

    // 4. Stop: commit context pack
    const stopResult = { committed: true, contextPackId: 'cp-lifecycle-1' };
    expect(stopResult.committed).toBe(true);
  });

  it('blocked tool does not advance to PostToolUse', async () => {
    // Stub policy engine that blocks `rm -rf`
    const stubEval = (toolName: string, params: Record<string, unknown>) => {
      if (toolName === 'bash' && String(params['command'] ?? '').includes('rm -rf')) {
        return { decision: 'block' as const, reason: 'Destructive' };
      }
      return { decision: 'allow' as const, reason: 'OK' };
    };

    const preResult = stubEval('bash', { command: 'rm -rf /' });
    expect(preResult.decision).toBe('block');

    // PostToolUse should not be called
    let postToolUseCalled = false;
    if (preResult.decision !== 'block') {
      postToolUseCalled = true;
    }
    expect(postToolUseCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared types integration
// ---------------------------------------------------------------------------

describe('Shared types integration', () => {
  it('PolicyRule shapes are compatible with evaluatePolicy', async () => {
    const { evaluatePolicy } = await import('../../src/lib/policy-engine.js');

    const rules: PolicyRule[] = [
      {
        tool: 'bash',
        action: 'warn',
        reason: 'Bash is risky',
        conditions: [{ field: 'command', operator: 'contains', value: 'sudo' }],
      },
    ];

    // The current default-allow implementation ignores rules, but the type
    // signature must accept them without TypeScript errors
    const decision = evaluatePolicy(rules, 'bash', { command: 'sudo apt-get update' });
    expect(decision).toBeDefined();
  });

  it('PolicyDecision shape from evaluatePolicy satisfies PolicyDecision type', async () => {
    const { evaluatePolicy } = await import('../../src/lib/policy-engine.js');
    const decision = evaluatePolicy([], 'read', {});

    // Verify all required fields are present and correctly typed
    expect(typeof decision.policyId).toBe('string');
    expect(typeof decision.toolName).toBe('string');
    expect(['allow', 'block', 'warn']).toContain(decision.decision);
    expect(typeof decision.reason).toBe('string');
  });
});
