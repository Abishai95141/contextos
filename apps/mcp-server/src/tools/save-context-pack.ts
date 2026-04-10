/**
 * MCP Tool: save_context_pack
 *
 * Saves a Context Pack to the append-only store.
 * Called by agents to record run context.
 */

import type { ContextPack } from '@contextos/shared';

export interface SaveContextPackInput {
  projectId: string;
  runId: string;
  issueRef?: string;
  content: ContextPack['content'];
  summary?: string;
}

export async function saveContextPack(_input: SaveContextPackInput): Promise<{ contextPackId: string }> {
  // TODO: Implement in Phase 1
  // 1. Validate input
  // 2. Write to append-only context_packs table
  // 3. Generate embedding for summary (async)
  // 4. Return context pack ID
  throw new Error('Not implemented — Phase 1');
}
