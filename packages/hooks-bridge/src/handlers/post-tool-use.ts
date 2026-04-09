/**
 * Hook: PostToolUse
 *
 * Fired after tool completion. Records trace event.
 * Non-blocking — does not slow the agent.
 */

export interface PostToolUseInput {
  sessionId: string;
  runId: string;
  toolName: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  durationMs: number;
}

export async function handlePostToolUse(
  _input: PostToolUseInput,
): Promise<void> {
  // TODO: Implement in Phase 2
  // 1. Generate idempotency key
  // 2. Append to run_events (non-blocking)
  throw new Error("Not implemented — Phase 2");
}
