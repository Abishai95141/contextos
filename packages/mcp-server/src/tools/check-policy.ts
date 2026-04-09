/**
 * MCP Tool: check_policy
 *
 * Evaluates a tool use request against project Run Policies.
 * Returns allow/block/warn with reason.
 */

import type { PolicyDecision } from "@contextos/shared";

export interface CheckPolicyInput {
  projectId: string;
  toolName: string;
  toolParams?: Record<string, unknown>;
}

export async function checkPolicy(
  _input: CheckPolicyInput,
): Promise<PolicyDecision> {
  // TODO: Implement in Phase 1
  // 1. Load active policies for project
  // 2. Evaluate each rule against tool name and params
  // 3. Return first blocking rule, or allow
  throw new Error("Not implemented — Phase 1");
}
