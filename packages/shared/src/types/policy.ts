export interface Policy {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  rules: PolicyRule[];
  isActive: boolean;
  createdAt: string;
}

export interface PolicyRule {
  tool: string;
  action: "allow" | "block" | "warn";
  conditions?: PolicyCondition[];
  reason: string;
}

export interface PolicyCondition {
  field: string;
  operator: "equals" | "contains" | "matches" | "not_equals";
  value: string;
}

export interface PolicyDecision {
  policyId: string;
  toolName: string;
  decision: "allow" | "block" | "warn";
  reason: string;
}
