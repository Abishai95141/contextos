/**
 * Hook: SessionStart
 *
 * Fired when a developer opens Claude Code on a project.
 * Looks up the active Feature Pack and returns it as additionalContext.
 */

export interface SessionStartInput {
  sessionId: string;
  projectPath: string;
}

export interface SessionStartOutput {
  additionalContext: string;
}

export async function handleSessionStart(
  _input: SessionStartInput,
): Promise<SessionStartOutput> {
  // TODO: Implement in Phase 2
  // 1. Identify project from path
  // 2. Look up active Feature Pack
  // 3. Run freshness check
  // 4. Return pack content as additionalContext
  throw new Error("Not implemented — Phase 2");
}
