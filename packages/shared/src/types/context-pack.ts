export interface ContextPack {
  id: string;
  projectId: string;
  runId: string;
  issueRef?: string;
  featurePackId?: string;
  featurePackVersion?: number;
  content: ContextPackContent;
  semanticDiff?: SemanticDiff;
  summary?: string;
  status: 'committed' | 'partial' | 'quarantined';
  agentName?: string;
  createdAt: string;
}

export interface ContextPackContent {
  toolTraces: ToolTrace[];
  decisions: Decision[];
  filesModified: string[];
  testsRun?: TestResult[];
}

export interface ToolTrace {
  toolName: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  durationMs: number;
  timestamp: string;
}

export interface Decision {
  description: string;
  rationale: string;
  alternatives?: string[];
  timestamp: string;
}

export interface SemanticDiff {
  apisAdded: string[];
  apisRemoved: string[];
  testsAdded: string[];
  testsBroken: string[];
  firstTimeTouches: string[];
  summary: string;
}

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  duration?: number;
}
