import { z } from 'zod';

export const ToolTraceSchema = z.object({
  toolName: z.string(),
  inputs: z.record(z.unknown()),
  outputs: z.record(z.unknown()),
  durationMs: z.number().int(),
  timestamp: z.string().datetime(),
});

export const DecisionSchema = z.object({
  description: z.string(),
  rationale: z.string(),
  alternatives: z.array(z.string()).optional(),
  timestamp: z.string().datetime(),
});

export const TestResultSchema = z.object({
  name: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  duration: z.number().optional(),
});

export const SemanticDiffSchema = z.object({
  apisAdded: z.array(z.string()),
  apisRemoved: z.array(z.string()),
  testsAdded: z.array(z.string()),
  testsBroken: z.array(z.string()),
  firstTimeTouches: z.array(z.string()),
  summary: z.string(),
});

export const ContextPackContentSchema = z.object({
  toolTraces: z.array(ToolTraceSchema),
  decisions: z.array(DecisionSchema),
  filesModified: z.array(z.string()),
  testsRun: z.array(TestResultSchema).optional(),
});

export const ContextPackSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  issueRef: z.string().optional(),
  featurePackId: z.string().uuid().optional(),
  featurePackVersion: z.number().int().optional(),
  content: ContextPackContentSchema,
  semanticDiff: SemanticDiffSchema.optional(),
  summary: z.string().optional(),
  status: z.enum(['committed', 'partial', 'quarantined']),
  agentName: z.string().optional(),
  createdAt: z.string().datetime(),
});

export const SaveContextPackInputSchema = z.object({
  runId: z.string().uuid().describe('The UUID of the current run, established during SessionStart hook'),
  title: z.string().min(1).max(500).describe('A descriptive title for this context pack'),
  content: z.string().min(1).describe('Full markdown-formatted content describing what was built'),
  featurePackId: z.string().uuid().optional().describe('The feature pack that guided this work'),
  metadata: z.record(z.unknown()).optional().describe('Additional structured metadata'),
});

export const SaveContextPackOutputSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  title: z.string(),
  embeddingJobId: z.string().describe('Queue job ID for async embedding generation'),
  savedAt: z.string().datetime(),
});

export const RecordDecisionInputSchema = z.object({
  runId: z.string().uuid(),
  description: z.string().min(1).max(1000),
  rationale: z.string().min(1),
  alternatives: z.array(z.string()).optional(),
});

export const RecordDecisionOutputSchema = z.object({
  eventId: z.string().uuid(),
  recordedAt: z.string().datetime(),
});

export type SaveContextPackInput = z.infer<typeof SaveContextPackInputSchema>;
export type SaveContextPackOutput = z.infer<typeof SaveContextPackOutputSchema>;
export type RecordDecisionInput = z.infer<typeof RecordDecisionInputSchema>;
export type RecordDecisionOutput = z.infer<typeof RecordDecisionOutputSchema>;
