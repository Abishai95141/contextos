import { randomUUID } from "node:crypto";

/**
 * Generate an idempotency key for a run event.
 * Format: {runId}:{eventType}:{toolName}:{timestamp}
 */
export function generateIdempotencyKey(
  runId: string,
  eventType: string,
  toolName?: string,
): string {
  const parts = [runId, eventType, toolName ?? "none", Date.now().toString()];
  return parts.join(":");
}

/**
 * Generate a unique run idempotency key.
 * Used to prevent duplicate runs on retry.
 */
export function generateRunKey(sessionId: string, projectId: string): string {
  return `run:${projectId}:${sessionId}:${randomUUID()}`;
}
