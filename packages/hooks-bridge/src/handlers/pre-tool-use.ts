/**
 * Hook: PreToolUse
 *
 * Fired before every tool execution.
 * Evaluates against Run Policies and returns allow/block/warn.
 */

export interface PreToolUseInput {
  sessionId: string;
  runId: string;
  toolName: string;
  toolParams: Record<string, unknown>;
}

export type PreToolUseResult =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "warn"; message: string };

export async function handlePreToolUse(
  _input: PreToolUseInput,
): Promise<PreToolUseResult> {
  // TODO: Implement in Phase 2
  // 1. Call Policy Engine
  // 2. Log decision to policy_decisions table
  // 3. Return result
  throw new Error("Not implemented — Phase 2");
}
