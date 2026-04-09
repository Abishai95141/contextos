/**
 * Unit tests for the SessionStart handler.
 */
import { describe, it, expect } from 'vitest';
import type {
  SessionStartInput,
  SessionStartOutput,
} from '../../../src/handlers/session-start.js';

const modulePromise = import('../../../src/handlers/session-start.js');

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

describe('handleSessionStart — module contract', () => {
  it('exports handleSessionStart as a function', async () => {
    const mod = await modulePromise;
    expect(typeof mod.handleSessionStart).toBe('function');
  });

  it('returns a Promise', async () => {
    const { handleSessionStart } = await modulePromise;
    const result = handleSessionStart({ sessionId: 'ses-1', projectPath: '/home/dev/myproject' });
    expect(result).toBeInstanceOf(Promise);
    await result.catch(() => undefined);
  });

  it('rejects with "Not implemented" for Phase 2', async () => {
    const { handleSessionStart } = await modulePromise;
    await expect(
      handleSessionStart({ sessionId: 'ses-1', projectPath: '/home/dev/myproject' }),
    ).rejects.toThrow(/not implemented/i);
  });
});

// ---------------------------------------------------------------------------
// Input type shapes
// ---------------------------------------------------------------------------

describe('SessionStartInput — type shapes', () => {
  it('accepts a valid input', () => {
    const input: SessionStartInput = {
      sessionId: 'ses-abc-123',
      projectPath: '/Users/alice/work/contextos',
    };
    expect(input.sessionId).toBe('ses-abc-123');
    expect(input.projectPath).toBe('/Users/alice/work/contextos');
  });

  it('accepts Windows-style paths', () => {
    const input: SessionStartInput = {
      sessionId: 'ses-win',
      projectPath: 'C:\\Users\\alice\\work\\project',
    };
    expect(input.projectPath).toContain('alice');
  });
});

// ---------------------------------------------------------------------------
// Output type shapes
// ---------------------------------------------------------------------------

describe('SessionStartOutput — type shapes', () => {
  it('requires additionalContext string', () => {
    const output: SessionStartOutput = {
      additionalContext: 'You are working on the ContextOS project.\n\nFeature Pack: ...',
    };
    expect(typeof output.additionalContext).toBe('string');
  });

  it('additionalContext can be an empty string', () => {
    const output: SessionStartOutput = { additionalContext: '' };
    expect(output.additionalContext).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Stub implementation tests (simulate Phase 2)
// ---------------------------------------------------------------------------

describe('handleSessionStart — stub-based behaviour tests', () => {
  type StubSessionStart = (input: SessionStartInput) => Promise<SessionStartOutput>;

  // A stub that returns a formatted context string based on the project path
  const stub: StubSessionStart = async (input) => {
    const projectName = input.projectPath.split('/').at(-1) ?? 'unknown';
    return {
      additionalContext: `# ContextOS Feature Pack\n\nProject: ${projectName}\nSession: ${input.sessionId}\n\nFollow the architectural constraints in this Feature Pack.`,
    };
  };

  it('returns additionalContext with project name', async () => {
    const result = await stub({ sessionId: 'ses-1', projectPath: '/home/dev/awesome-project' });
    expect(result.additionalContext).toContain('awesome-project');
  });

  it('includes sessionId in context', async () => {
    const result = await stub({ sessionId: 'ses-xyz', projectPath: '/home/dev/project' });
    expect(result.additionalContext).toContain('ses-xyz');
  });

  it('returns non-empty context for valid input', async () => {
    const result = await stub({ sessionId: 'ses-1', projectPath: '/app' });
    expect(result.additionalContext.trim().length).toBeGreaterThan(0);
  });

  it('handles path with trailing slash', async () => {
    const result = await stub({ sessionId: 'ses-1', projectPath: '/home/dev/project/' });
    expect(result.additionalContext).toBeDefined();
  });

  it('stub does not throw for any valid input', async () => {
    const inputs: SessionStartInput[] = [
      { sessionId: 'a', projectPath: '/a' },
      { sessionId: 'b', projectPath: '/very/deep/path/to/project' },
      { sessionId: 'c', projectPath: '.' },
    ];
    for (const input of inputs) {
      await expect(stub(input)).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('handleSessionStart — error handling', () => {
  it('a stub that fails still rejects with an Error', async () => {
    const failingStub: (input: SessionStartInput) => Promise<SessionStartOutput> = async () => {
      throw new Error('Project not found in database');
    };

    await expect(
      failingStub({ sessionId: 'ses-1', projectPath: '/nonexistent' }),
    ).rejects.toThrow('Project not found');
  });
});
