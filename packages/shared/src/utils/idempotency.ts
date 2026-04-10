/**
 * Generate an idempotency key for a run event.
 * Includes a timestamp so each event occurrence produces a unique key.
 * Format: {runId}:{eventType}:{toolName}:{timestamp}
 */
export function generateIdempotencyKey(runId: string, eventType: string, toolName?: string): string {
  const parts = [runId, eventType, toolName ?? 'none', Date.now().toString()];
  return parts.join(':');
}

/**
 * Generate a unique run key.
 * Includes a UUID so each new run record is distinct even for the same session.
 * Format: run:{projectId}:{sessionId}:{uuid}
 */
export function generateRunKey(projectId: string, sessionId: string): string {
  return `run:${projectId}:${sessionId}:${crypto.randomUUID()}`;
}

/**
 * Generate a deterministic idempotency key for a context pack.
 * Idempotent on (runId, title): re-saving the same pack returns the existing record.
 */
export function generateContextPackKey(runId: string, title: string): string {
  const slug = title.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 100);
  return `ctx:${runId}:${slug}`;
}

/**
 * Generate a deterministic idempotency key for a policy decision audit entry.
 * Prevents duplicate audit rows on hook retry.
 */
export function generatePolicyDecisionKey(sessionId: string, toolName: string, eventType: string): string {
  return `pd:${sessionId}:${toolName}:${eventType}`;
}
