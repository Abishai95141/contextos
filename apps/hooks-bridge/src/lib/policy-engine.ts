/**
 * Policy Engine
 *
 * Evaluates PreToolUse events against project Run Policies.
 * Server-side, isolated from pack contents.
 */

import { randomUUID } from 'node:crypto';
import type { PolicyDecision, PolicyRule } from '@contextos/shared';
import { generatePolicyDecisionKey } from '@contextos/shared';

export function evaluatePolicy(
  _rules: PolicyRule[],
  toolName: string,
  _toolParams: Record<string, unknown>,
  sessionId: string,
  eventType: string,
  policyId: string,
): PolicyDecision {
  // TODO: Implement in Phase 2 — glob-match rules by priority
  return {
    id: randomUUID(),
    policyId,
    toolName,
    decision: 'allow',
    reason: 'No policies configured — default allow',
    idempotencyKey: generatePolicyDecisionKey(sessionId, toolName, eventType),
    evaluatedAt: new Date().toISOString(),
  };
}
