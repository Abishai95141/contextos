import { z } from 'zod';

export const PolicyRuleSchema = z.object({
  id: z.string().uuid(),
  policyId: z.string().uuid(),
  name: z.string(),
  eventType: z.enum(['PreToolUse', 'PostToolUse', 'PermissionRequest', '*']),
  toolPattern: z.string().min(1),
  pathPattern: z.string().optional(),
  decision: z.enum(['allow', 'deny', 'warn']),
  priority: z.number().int().min(0).default(100),
  isActive: z.boolean(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
});

export const PolicySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  isActive: z.boolean(),
  createdBy: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CheckPolicyInputSchema = z.object({
  projectSlug: z.string().min(1).max(100),
  sessionId: z.string().min(1).describe('Claude Code session_id'),
  eventType: z.enum(['PreToolUse', 'PostToolUse', 'PermissionRequest']),
  toolName: z.string().min(1).describe('The tool name (e.g., "Edit", "Bash", "Write")'),
  toolInput: z.record(z.unknown()).describe('The full tool input object'),
  featurePackId: z.string().uuid().optional().describe('If provided, also evaluate pack-specific rules'),
});

export const CheckPolicyOutputSchema = z.object({
  decision: z.enum(['allow', 'deny', 'warn']),
  matchedRuleId: z.string().uuid().nullable(),
  matchedRuleName: z.string().nullable(),
  reason: z.string(),
  evaluatedRuleCount: z.number().int(),
  checkedAt: z.string().datetime(),
});

export const PolicyDecisionSchema = z.object({
  id: z.string().uuid(),
  policyId: z.string().uuid(),
  ruleId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  sessionId: z.string().optional(),
  toolName: z.string(),
  decision: z.enum(['allow', 'deny', 'warn']),
  reason: z.string().optional(),
  idempotencyKey: z.string(),
  evaluatedAt: z.string().datetime(),
});

export type CheckPolicyInput = z.infer<typeof CheckPolicyInputSchema>;
export type CheckPolicyOutput = z.infer<typeof CheckPolicyOutputSchema>;
