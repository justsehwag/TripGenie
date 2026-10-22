/**
 * AWS bindings configuration for TripGenie.
 *
 * All values are read from environment variables. No secrets are inlined here;
 * supplier/provider credentials are resolved from AWS Secrets Manager at
 * runtime (design: Security — Secrets Manager, Req 17.3), never from this module.
 *
 * This module exposes only non-secret bindings: region, table names, and the
 * MCP tool allowlist. Reading a secret value through this module is intentionally
 * not supported.
 *
 * Requirements: 19.1 (serverless-first bindings), 17.3 (no inlined secrets).
 */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export interface AwsConfig {
  /** AWS region for all managed services. */
  readonly region: string;
  readonly tables: {
    /** DynamoDB Profiles table name (single-item-per-user). */
    readonly profiles: string;
    /** DynamoDB Trips table name (TTL, owner-scoped). */
    readonly trips: string;
  };
  readonly dynamo: {
    /** GSI enforcing idempotent save on (owner, clientDraftId) (Req 13.3). */
    readonly ownerDraftIndex: string;
    /** GSI enabling newest-5 retrieval/retention on (owner, updatedAt) (Req 13.4/13.5). */
    readonly ownerUpdatedIndex: string;
  };
  /** Allowlisted MCP tool names; only these may be invoked (Req 16.1/16.2). */
  readonly mcpToolAllowlist: readonly string[];
  /** Allowlisted HTTPS image hosts for the Imagery Service (Req 11.3). */
  readonly imageHostAllowlist: readonly string[];
  /**
   * Non-secret Amazon Bedrock bindings for the server-side Bedrock_Route
   * (Req 3.1/3.3/3.4). Only a model identifier and region are read here —
   * both have documented defaults so module load never throws when the env
   * vars are absent. No credential or secret is read: Bedrock access is
   * resolved at runtime through the Amplify execution role, not this module.
   */
  readonly bedrock: {
    /** Amazon Bedrock model identifier (BEDROCK_MODEL_ID). */
    readonly modelId: string;
    /** Amazon Bedrock region (BEDROCK_REGION, else AWS_REGION). */
    readonly region: string;
  };
  /** Non-secret Cognito user-pool bindings for server-side auth routes. */
  readonly cognito: {
    readonly userPoolId: string;
    readonly clientId: string;
    readonly region: string;
  };
  /** Mandatory resource tags applied to every provisioned AWS resource
   * so the create-only-if-tagged account policy is satisfied (Task 24/27). */
  readonly resourceTags: { readonly Name: string; readonly Purpose: string };
}

const DEFAULT_MCP_TOOL_ALLOWLIST = [
  "search_travel_inventory",
  "search_destination_places",
  "get_destination_context",
  "get_weather",
  "convert_currency",
  "resolve_imagery",
  "book_offer_set",
];

const DEFAULT_IMAGE_HOST_ALLOWLIST = [
  "upload.wikimedia.org",
  "commons.wikimedia.org",
  "picsum.photos",
  "fastly.picsum.photos",
  "i.picsum.photos",
];

export function loadAwsConfig(): AwsConfig {
  return {
    region: env("AWS_REGION", "us-east-1"),
    tables: {
      profiles: env("TRIPGENIE_PROFILES_TABLE", "tripgenie-profiles"),
      trips: env("TRIPGENIE_TRIPS_TABLE", "tripgenie-trips"),
    },
    dynamo: {
      ownerDraftIndex: env("TRIPGENIE_TRIPS_OWNER_DRAFT_INDEX", "owner-draft"),
      ownerUpdatedIndex: env(
        "TRIPGENIE_TRIPS_OWNER_UPDATED_INDEX",
        "owner-updated"
      ),
    },
    mcpToolAllowlist: envList(
      "TRIPGENIE_MCP_TOOL_ALLOWLIST",
      DEFAULT_MCP_TOOL_ALLOWLIST
    ),
    imageHostAllowlist: envList(
      "TRIPGENIE_IMAGE_HOST_ALLOWLIST",
      DEFAULT_IMAGE_HOST_ALLOWLIST
    ),
    // Non-secret Bedrock bindings; documented defaults keep module load
    // throw-free when the env vars are unset (Req 3.4). No secret is read —
    // Bedrock access is via the Amplify execution role at runtime (Req 3.2/3.3).
    bedrock: {
      modelId: env(
        "BEDROCK_MODEL_ID",
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
      ),
      region: env("BEDROCK_REGION", env("AWS_REGION", "us-east-1")),
    },
    cognito: {
      userPoolId: env("COGNITO_USER_POOL_ID", ""),
      clientId: env("COGNITO_CLIENT_ID", ""),
      region: env("COGNITO_REGION", env("AWS_REGION", "us-east-1")),
    },
    resourceTags: {
      Name: env("TRIPGENIE_TAG_NAME", "Seshathri Y"),
      Purpose: env(
        "TRIPGENIE_TAG_PURPOSE",
        "TripGenie - AI-powered travel planning concierge",
      ),
    },
  };
}

/** Singleton config loaded once from the environment. */
export const awsConfig: AwsConfig = loadAwsConfig();
