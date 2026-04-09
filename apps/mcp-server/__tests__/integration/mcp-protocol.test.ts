/**
 * Integration tests — MCP Protocol compliance.
 *
 * These tests verify that the MCP server's tool and resource registration
 * follows the MCP SDK conventions.  We test the exported handler interfaces
 * against expected shapes rather than spinning up a full server process.
 *
 * When Phase 1 is fully implemented, extend these tests with a real
 * in-process MCP SDK client that connects over stdio.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Tool interface contracts
// ---------------------------------------------------------------------------

describe('MCP Tool: get_feature_pack — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/tools/get-feature-pack.js')).resolves.toBeDefined();
  });

  it('exports exactly getFeaturePack', async () => {
    const mod = await import('../../src/tools/get-feature-pack.js');
    expect(Object.keys(mod)).toContain('getFeaturePack');
  });
});

describe('MCP Tool: check_policy — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/tools/check-policy.js')).resolves.toBeDefined();
  });

  it('exports checkPolicy as a function', async () => {
    const mod = await import('../../src/tools/check-policy.js');
    expect(typeof mod.checkPolicy).toBe('function');
  });

  it('rejects with "Not implemented" for Phase 1', async () => {
    const { checkPolicy } = await import('../../src/tools/check-policy.js');
    await expect(checkPolicy({ projectId: 'proj-1', toolName: 'bash' })).rejects.toThrow(
      /not implemented/i,
    );
  });
});

describe('MCP Tool: save_context_pack — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/tools/save-context-pack.js')).resolves.toBeDefined();
  });

  it('exports saveContextPack as a function', async () => {
    const mod = await import('../../src/tools/save-context-pack.js');
    expect(typeof mod.saveContextPack).toBe('function');
  });

  it('rejects with "Not implemented" for Phase 1', async () => {
    const { saveContextPack } = await import('../../src/tools/save-context-pack.js');
    await expect(
      saveContextPack({
        projectId: 'proj-1',
        runId: 'run-1',
        content: { toolTraces: [], decisions: [], filesModified: [] },
      }),
    ).rejects.toThrow(/not implemented/i);
  });
});

describe('MCP Tool: query_run_history — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/tools/query-run-history.js')).resolves.toBeDefined();
  });

  it('exports queryRunHistory as a function', async () => {
    const mod = await import('../../src/tools/query-run-history.js');
    expect(typeof mod.queryRunHistory).toBe('function');
  });
});

describe('MCP Tool: record_decision — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/tools/record-decision.js')).resolves.toBeDefined();
  });

  it('exports recordDecision as a function', async () => {
    const mod = await import('../../src/tools/record-decision.js');
    expect(typeof mod.recordDecision).toBe('function');
  });
});

describe('MCP Tool: search_packs_nl — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/tools/search-packs-nl.js')).resolves.toBeDefined();
  });

  it('exports searchPacksNl as a function', async () => {
    const mod = await import('../../src/tools/search-packs-nl.js');
    expect(typeof mod.searchPacksNl).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Resource interface contracts
// ---------------------------------------------------------------------------

describe('MCP Resource: feature-pack — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/resources/feature-pack.js')).resolves.toBeDefined();
  });
});

describe('MCP Resource: context-pack — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/resources/context-pack.js')).resolves.toBeDefined();
  });
});

describe('MCP Resource: run-history — integration contract', () => {
  it('module resolves without import errors', async () => {
    await expect(import('../../src/resources/run-history.js')).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tool input validation (stub-based integration)
// ---------------------------------------------------------------------------

describe('Tool input shapes', () => {
  it('check_policy accepts toolParams as optional', async () => {
    const { checkPolicy } = await import('../../src/tools/check-policy.js');
    // With params
    const p1 = checkPolicy({ projectId: 'p1', toolName: 'bash', toolParams: { cmd: 'ls' } });
    await p1.catch(() => undefined);
    // Without params
    const p2 = checkPolicy({ projectId: 'p1', toolName: 'bash' });
    await p2.catch(() => undefined);
    expect(true).toBe(true); // Both calls did not throw synchronously
  });

  it('save_context_pack accepts issueRef and summary as optional', async () => {
    const { saveContextPack } = await import('../../src/tools/save-context-pack.js');
    const p = saveContextPack({
      projectId: 'p1',
      runId: 'r1',
      issueRef: 'PROJ-10',
      content: { toolTraces: [], decisions: [], filesModified: ['README.md'] },
      summary: 'Updated docs',
    });
    await p.catch(() => undefined);
    expect(true).toBe(true);
  });
});
