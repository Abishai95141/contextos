import { z } from 'zod';

export const RunSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sessionId: z.string(),
  idempotencyKey: z.string(),
  featurePackId: z.string().uuid().optional(),
  issueRef: z.string().optional(),
  agentName: z.string().optional(),
  status: z.enum(['in_progress', 'completed', 'interrupted']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});

export const RunEventSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  eventType: z.enum(['tool_use', 'policy_check', 'decision']),
  toolName: z.string().optional(),
  inputs: z.record(z.unknown()).optional(),
  outputs: z.record(z.unknown()).optional(),
  durationMs: z.number().int().optional(),
  idempotencyKey: z.string(),
  createdAt: z.string().datetime(),
});

export const QueryRunHistoryInputSchema = z.object({
  projectSlug: z.string().min(1).max(100),
  issueRef: z.string().optional().describe('Filter to runs for a specific issue (e.g., "GH-142")'),
  status: z.enum(['in_progress', 'completed', 'interrupted']).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional().describe('Pagination cursor — the ID of the last run from the previous page'),
});

export const QueryRunHistoryOutputSchema = z.object({
  runs: z.array(RunSchema),
  nextCursor: z.string().uuid().nullable(),
  total: z.number().int(),
});

export type QueryRunHistoryInput = z.infer<typeof QueryRunHistoryInputSchema>;
export type QueryRunHistoryOutput = z.infer<typeof QueryRunHistoryOutputSchema>;
