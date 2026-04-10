/**
 * MCP Tool: record_decision
 *
 * Records an architectural or implementation decision made during a run.
 * Stored in the Context Pack for future reference.
 */

export interface RecordDecisionInput {
  runId: string;
  description: string;
  rationale: string;
  alternatives?: string[];
}

export async function recordDecision(_input: RecordDecisionInput): Promise<{ recorded: boolean }> {
  // TODO: Implement in Phase 1
  throw new Error('Not implemented — Phase 1');
}
