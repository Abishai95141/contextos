/**
 * MCP Tool: get_feature_pack
 *
 * Retrieves the active Feature Pack for a given project/issue.
 * Includes freshness evaluation — if stale, returns pack + staleness notice.
 */

import type { FeaturePack } from '@contextos/shared';

export interface GetFeaturePackInput {
  projectId: string;
  issueRef?: string;
}

export interface GetFeaturePackOutput {
  pack: FeaturePack;
  isStale: boolean;
  stalenessReason?: string;
}

export async function getFeaturePack(_input: GetFeaturePackInput): Promise<GetFeaturePackOutput> {
  // TODO: Implement in Phase 1
  // 1. Look up active Feature Pack for project
  // 2. Run freshness check (file-level + semantic)
  // 3. Return pack with staleness info
  throw new Error('Not implemented — Phase 1');
}
