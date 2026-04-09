/**
 * Hook: Stop
 *
 * Fired when the agent finishes. Triggers Context Pack assembly.
 */

export interface StopInput {
  sessionId: string;
  runId: string;
}

export async function handleStop(
  _input: StopInput,
): Promise<{ contextPackId: string }> {
  // TODO: Implement in Phase 2
  // 1. Collect all run events for this session
  // 2. Assemble Context Pack atomically (staged write)
  // 3. Mark as committed on clean session end
  // 4. If interrupted: flag as partial, quarantine
  throw new Error("Not implemented — Phase 2");
}
