/**
 * MCP Tool: search_packs_nl
 *
 * Semantic search over the Context Pack archive using pgvector.
 * Returns relevant prior packs for a described task.
 */

import type { ContextPack } from "@contextos/shared";

export interface SearchPacksNlInput {
  projectId: string;
  query: string;
  limit?: number;
}

export interface SearchPacksNlOutput {
  packs: Array<{
    pack: ContextPack;
    relevanceScore: number;
  }>;
}

export async function searchPacksNl(
  _input: SearchPacksNlInput,
): Promise<SearchPacksNlOutput> {
  // TODO: Implement in Phase 1
  // 1. Generate embedding for query
  // 2. pgvector cosine similarity search
  // 3. Filter by project (tenant isolation)
  // 4. Return ranked results
  throw new Error("Not implemented — Phase 1");
}
