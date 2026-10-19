import { awsConfig, type AwsConfig } from "./config";

/**
 * AWS security controls as Infrastructure-as-Code - design section "Security".
 * Pure generator: produces least-privilege IAM role policies, KMS encryption,
 * Secrets Manager references, Bedrock Guardrail bindings, and CloudTrail
 * config - each resource carrying the mandatory resource tags. No live AWS
 * calls are made; this is the testable-offline source of truth for Task 24/27.
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5.
 */

export interface IamStatement {
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string[];
}

export interface IamRole {
  name: string;
  /** The exact resource ARNs (or symbolic ids) this role is scoped to. */
  scope: string[];
  statements: IamStatement[];
}

export type Tags = { Name: string; Purpose: string };

export interface TaggedResource {
  kind: string;
  id: string;
  tags: Tags;
  /** True iff encryption at rest (KMS) applies to this resource. */
  kmsEncrypted: boolean;
}

export interface SecurityPlan {
  roles: IamRole[];
  resources: TaggedResource[];
  secrets: string[];
  guardrail: { appliesToInput: boolean; appliesToOutput: boolean };
  cloudTrail: { enabled: boolean; recordsControlPlane: boolean };
}

/**
 * Build the security plan. Each Lambda role is scoped to only the resources
 * it touches; Profiles/Trips tables and AgentCore Memory are KMS-encrypted;
 * supplier credentials resolve from Secrets Manager; Guardrails guard both
 * model input and output; CloudTrail records control-plane actions.
 */
export function buildSecurityPlan(config: AwsConfig = awsConfig): SecurityPlan {
  const tags: Tags = { ...config.resourceTags };
  const region = config.region;
  const profilesArn = `arn:aws:dynamodb:${region}:*:table/${config.tables.profiles}`;
  const tripsArn = `arn:aws:dynamodb:${region}:*:table/${config.tables.trips}`;
  const tripsIdxArn = `${tripsArn}/index/*`;
  const secretsArn = `arn:aws:secretsmanager:${region}:*:secret:tripgenie/*`;
  const memoryArn = `arn:aws:bedrock-agentcore:${region}:*:memory/tripgenie/*`;

  const roles: IamRole[] = [
    {
      name: "tripgenie-trips-fn",
      scope: [tripsArn, tripsIdxArn],
      statements: [
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem"],
          Resource: [tripsArn, tripsIdxArn],
        },
      ],
    },
    {
      name: "tripgenie-profile-fn",
      scope: [profilesArn],
      statements: [
        {
          Effect: "Allow",
          Action: ["dynamodb:GetItem", "dynamodb:PutItem"],
          Resource: [profilesArn],
        },
      ],
    },
    {
      name: "tripgenie-controller-fn",
      scope: [secretsArn, memoryArn],
      statements: [
        { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: [secretsArn] },
        { Effect: "Allow", Action: ["bedrock-agentcore:GetMemoryRecord", "bedrock-agentcore:CreateMemoryRecord"], Resource: [memoryArn] },
      ],
    },
  ];

  const resources: TaggedResource[] = [
    { kind: "dynamodb-table", id: config.tables.profiles, tags: { ...tags }, kmsEncrypted: true },
    { kind: "dynamodb-table", id: config.tables.trips, tags: { ...tags }, kmsEncrypted: true },
    { kind: "agentcore-memory", id: "tripgenie-memory", tags: { ...tags }, kmsEncrypted: true },
    { kind: "kms-key", id: "tripgenie-kms", tags: { ...tags }, kmsEncrypted: true },
    { kind: "cloudtrail", id: "tripgenie-trail", tags: { ...tags }, kmsEncrypted: true },
  ];

  return {
    roles,
    resources,
    secrets: [secretsArn],
    guardrail: { appliesToInput: true, appliesToOutput: true },
    cloudTrail: { enabled: true, recordsControlPlane: true },
  };
}

/** A role is least-privilege iff every Allow resource is within its declared scope
 * and it claims no wildcard-all ("*") resource. */
export function roleIsLeastPrivilege(role: IamRole): boolean {
  const scope = new Set(role.scope);
  for (const s of role.statements) {
    if (s.Effect !== "Allow") continue;
    for (const r of s.Resource) {
      if (r === "*") return false;
      if (!scope.has(r)) return false;
    }
  }
  return true;
}
