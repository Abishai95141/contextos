import { describe, it, expect } from 'vitest';
import { generateIdempotencyKey, generateRunKey } from '../../src/utils/idempotency.js';

describe('generateIdempotencyKey', () => {
  it('returns a non-empty string', () => {
    const key = generateIdempotencyKey('run-1', 'tool_use', 'bash');
    expect(key).toBeTruthy();
    expect(typeof key).toBe('string');
  });

  it('includes all provided components', () => {
    const runId = 'run-abc-123';
    const eventType = 'tool_use';
    const toolName = 'bash';
    const key = generateIdempotencyKey(runId, eventType, toolName);
    expect(key).toContain(runId);
    expect(key).toContain(eventType);
    expect(key).toContain(toolName);
  });

  it('uses "none" when toolName is omitted', () => {
    const key = generateIdempotencyKey('run-1', 'decision');
    expect(key).toContain('none');
  });

  it('uses "none" when toolName is undefined', () => {
    const key = generateIdempotencyKey('run-1', 'decision', undefined);
    expect(key).toContain('none');
  });

  it('produces different keys on consecutive calls (timestamp-based)', async () => {
    // Consecutive calls should differ because they embed Date.now()
    const k1 = generateIdempotencyKey('run-1', 'tool_use', 'read');
    await new Promise((r) => setTimeout(r, 2));
    const k2 = generateIdempotencyKey('run-1', 'tool_use', 'read');
    expect(k1).not.toBe(k2);
  });

  it('uses colon as delimiter', () => {
    const key = generateIdempotencyKey('run-1', 'tool_use', 'bash');
    const parts = key.split(':');
    // Expect at least 4 colon-separated segments
    expect(parts.length).toBeGreaterThanOrEqual(4);
  });

  it('format is {runId}:{eventType}:{toolName}:{timestamp}', () => {
    const runId = 'aaaa-bbbb';
    const eventType = 'policy_check';
    const toolName = 'write';
    const before = Date.now();
    const key = generateIdempotencyKey(runId, eventType, toolName);
    const after = Date.now();
    const parts = key.split(':');
    expect(parts[0]).toBe(runId);
    expect(parts[1]).toBe(eventType);
    expect(parts[2]).toBe(toolName);
    const ts = Number(parts[3]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('generateRunKey', () => {
  it('returns a non-empty string', () => {
    const key = generateRunKey('session-1', 'project-1');
    expect(key).toBeTruthy();
    expect(typeof key).toBe('string');
  });

  it('starts with "run:"', () => {
    const key = generateRunKey('session-1', 'project-1');
    expect(key.startsWith('run:')).toBe(true);
  });

  it('includes projectId and sessionId', () => {
    const sessionId = 'ses-xyz';
    const projectId = 'proj-abc';
    const key = generateRunKey(sessionId, projectId);
    expect(key).toContain(projectId);
    expect(key).toContain(sessionId);
  });

  it('produces unique keys on each call', () => {
    const k1 = generateRunKey('session-1', 'project-1');
    const k2 = generateRunKey('session-1', 'project-1');
    expect(k1).not.toBe(k2);
  });

  it('produces unique keys for different sessions', () => {
    const k1 = generateRunKey('session-A', 'project-1');
    const k2 = generateRunKey('session-B', 'project-1');
    expect(k1).not.toBe(k2);
  });

  it('produces unique keys for different projects', () => {
    const k1 = generateRunKey('session-1', 'project-A');
    const k2 = generateRunKey('session-1', 'project-B');
    expect(k1).not.toBe(k2);
  });
});
