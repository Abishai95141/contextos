export interface FeaturePack {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  version: number;
  parentPackId?: string;
  content: FeaturePackContent;
  sourceFiles?: string[];
  isActive: boolean;
  isStale: boolean;
  createdBy?: string; // Clerk user ID
  createdAt: string;
  updatedAt: string;
}

export interface FeaturePackContent {
  description: string;
  architecture?: string;
  adrs?: ArchitectureDecisionRecord[];
  constraints?: string[];
  toolPermissions?: ToolPermission[];
  testStrategy?: string;
  references?: FileReference[];
}

export interface ArchitectureDecisionRecord {
  id: string;
  title: string;
  status: 'accepted' | 'deprecated' | 'superseded';
  context: string;
  decision: string;
  consequences: string;
}

export interface ToolPermission {
  tool: string;
  allowed: boolean;
  reason?: string;
}

export interface FileReference {
  path: string;
  description?: string;
  lastKnownHash?: string;
}
