export interface Run {
  id: string;
  projectId: string;
  sessionId: string;
  idempotencyKey: string;
  featurePackId?: string;
  issueRef?: string;
  agentName?: string;
  status: "in_progress" | "completed" | "interrupted";
  startedAt: string;
  completedAt?: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  eventType: "tool_use" | "policy_check" | "decision";
  toolName?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  durationMs?: number;
  createdAt: string;
}
