/**
 * MCP Tool: query_run_history
 *
 * Queries run history for a project/issue.
 */

import type { Run } from '@contextos/shared';

export interface QueryRunHistoryInput {
  projectId: string;
  issueRef?: string;
  limit?: number;
}

export async function queryRunHistory(_input: QueryRunHistoryInput): Promise<Run[]> {
  // TODO: Implement in Phase 1
  throw new Error('Not implemented — Phase 1');
}
