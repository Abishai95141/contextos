export interface Policy {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  isActive: boolean;
  createdBy?: string; // Clerk user ID
  createdAt: string;
  updatedAt: string;
}

export interface PolicyRule {
  id: string;
  policyId: string;
  name: string;
  eventType: 'PreToolUse' | 'PostToolUse' | 'PermissionRequest' | '*';
  toolPattern: string; // glob, e.g. "Bash", "Write*", "*"
  pathPattern?: string; // glob, e.g. "**/node_modules/**"
  decision: 'allow' | 'deny' | 'warn';
  priority: number; // lower number = higher priority
  isActive: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PolicyDecision {
  id: string;
  policyId: string;
  ruleId?: string; // null = no rule matched (default allow)
  runId?: string;
  sessionId?: string;
  toolName: string;
  decision: 'allow' | 'deny' | 'warn';
  reason?: string;
  idempotencyKey: string;
  evaluatedAt: string;
}
