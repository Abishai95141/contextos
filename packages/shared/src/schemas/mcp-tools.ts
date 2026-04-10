/**
 * MCP Tool Schemas
 *
 * Re-exports all MCP tool input/output Zod schemas used by both the MCP server
 * (for validation) and the hooks bridge (for event payloads).
 */

export {
  type RecordDecisionInput,
  RecordDecisionInputSchema,
  type RecordDecisionOutput,
  RecordDecisionOutputSchema,
  type SaveContextPackInput,
  SaveContextPackInputSchema,
  type SaveContextPackOutput,
  SaveContextPackOutputSchema,
} from './context-pack.js';
export {
  type GetFeaturePackInput,
  GetFeaturePackInputSchema,
  type GetFeaturePackOutput,
  GetFeaturePackOutputSchema,
} from './feature-pack.js';
export {
  type CheckPolicyInput,
  CheckPolicyInputSchema,
  type CheckPolicyOutput,
  CheckPolicyOutputSchema,
} from './policy.js';
export {
  type QueryRunHistoryInput,
  QueryRunHistoryInputSchema,
  type QueryRunHistoryOutput,
  QueryRunHistoryOutputSchema,
} from './run.js';

/**
 * Search packs by natural language query (delegated to NL Assembly service).
 */
import { z } from 'zod';

export const SearchPacksNlInputSchema = z.object({
  projectSlug: z.string().min(1).max(100),
  query: z.string().min(1).max(1000).describe('Natural language search query'),
  limit: z.number().int().min(1).max(20).default(5),
});

export const SearchPacksNlOutputSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      summary: z.string(),
      score: z.number().min(0).max(1),
      createdAt: z.string().datetime(),
    }),
  ),
  query: z.string(),
  searchedAt: z.string().datetime(),
});

export type SearchPacksNlInput = z.infer<typeof SearchPacksNlInputSchema>;
export type SearchPacksNlOutput = z.infer<typeof SearchPacksNlOutputSchema>;
