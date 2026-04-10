/**
 * Hook: SessionEnd
 *
 * Fired when the Claude Code session terminates (user exits, /clear, /resume switch, logout).
 * This is NOT the Stop hook (which fires on every turn). SessionEnd fires exactly once.
 * Triggers run finalization and Context Pack assembly.
 */

export interface SessionEndInput {
  sessionId: string;
  runId: string;
  reason?: string;
}

export async function handleSessionEnd(_input: SessionEndInput): Promise<void> {
  // TODO: Implement in Phase 2
  // 1. Update run status to 'completed'
  // 2. Enqueue context-pack-assembly BullMQ job
  // 3. Clean up Redis session key
  // 4. Respond with empty 200 (SessionEnd has no decision control)
  throw new Error('Not implemented — Phase 2');
}
