/**
 * Policy Engine
 *
 * Evaluates PreToolUse events against project Run Policies.
 * Server-side, isolated from pack contents.
 */

import type { PolicyDecision, PolicyRule } from "@contextos/shared";

export function evaluatePolicy(
  _rules: PolicyRule[],
  _toolName: string,
  _toolParams: Record<string, unknown>,
): PolicyDecision {
  // TODO: Implement in Phase 2
  // Default: allow everything
  return {
    policyId: "default",
    toolName: _toolName,
    decision: "allow",
    reason: "No policies configured — default allow",
  };
}
