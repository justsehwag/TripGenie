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

import { parseSoftLimit } from "@/lib/providers/provider-store";

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
  "thumb.wikimedia.org",
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

/**
 * Server-only accessor for the Google Places API key.
 *
 * Reads the key from the `GOOGLE_PLACES_API_KEY` env var (a secret, so it is
 * deliberately NOT prefixed with `NEXT_PUBLIC_`) via the same `env` helper used
 * for the non-secret bindings above (Req 1.3). Returns "" when unconfigured so
 * callers degrade to a labelled fallback and issue no outbound request
 * (Req 10.4).
 *
 * This value is intentionally kept off the `AwsConfig` interface and the
 * exported `awsConfig` object: it is a secret and must never be serialized into
 * any response or reach the client bundle (Req 1.4). Import this accessor from
 * server-only code paths only.
 */
export function googlePlacesApiKey(): string {
  return env("GOOGLE_PLACES_API_KEY", "");
}

/**
 * Server-only accessor for the SerpApi key (Google Hotels live pricing).
 *
 * Reads `SERPAPI_API_KEY` (a secret; deliberately NOT `NEXT_PUBLIC_`). Returns
 * "" when unconfigured so callers fall back to labelled estimates and issue no
 * outbound request. Never serialize this value into a response or the client
 * bundle; import it from server-only code paths only.
 */
export function serpApiKey(): string {
  return env("SERPAPI_API_KEY", "");
}

/**
 * Server-only accessor for the SerpApi monthly soft limit (usage guard).
 *
 * Reads `SERPAPI_MONTHLY_SOFT_LIMIT`; a positive integer is used as-is, any
 * other value (unset, blank, zero, negative, non-numeric) falls back to the
 * default (Req 8.2, 8.3). Kept off `AwsConfig` like the other provider
 * settings so it is never serialized into a response (Req 8.7).
 */
export function serpApiMonthlySoftLimit(): number {
  return parseSoftLimit(process.env.SERPAPI_MONTHLY_SOFT_LIMIT);
}

/**
 * Server-only accessor for the SearXNG instance base URL.
 *
 * Reads `SEARXNG_BASE_URL` (not `NEXT_PUBLIC_`). Returns "" unless the value
 * parses as an `https:` URL with no username or password. The result is
 * `origin + pathname` with trailing slashes removed (query and hash dropped).
 * Kept off `AwsConfig`; never log or serialize it.
 */
export function searxngBaseUrl(): string {
  const raw = env("SEARXNG_BASE_URL", "");
  if (raw === "") return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  if (url.username !== "" || url.password !== "") return "";
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/**
 * Server-only accessor for the SearXNG secret header.
 *
 * Returns `null` unless `SEARXNG_SECRET_HEADER_NAME` (a valid HTTP token) and
 * `SEARXNG_SECRET_HEADER_VALUE` (no CR or LF) are both non-empty after
 * trimming. Never log or serialize the value.
 */
export function searxngSecretHeader(): { name: string; value: string } | null {
  const name = env("SEARXNG_SECRET_HEADER_NAME", "");
  const value = env("SEARXNG_SECRET_HEADER_VALUE", "");
  if (name === "" || value === "") return null;
  if (!/^[A-Za-z0-9-]+$/.test(name)) return null;
  if (/[\r\n]/.test(value)) return null;
  return { name, value };
}

/**
 * Whether SearXNG itinerary grounding is switched on. Read on every call from
 * `TRIPGENIE_SEARXNG_ENABLED`; on only for `true` or `1` (trimmed,
 * case-insensitive), off for anything else.
 */
export function searxngEnabled(): boolean {
  const v = (process.env.TRIPGENIE_SEARXNG_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Whether web-grounded activity pricing is switched on. Read on every call from
 * `TRIPGENIE_WEB_PRICING_ENABLED`; on only for `true` or `1` (trimmed,
 * case-insensitive), off for anything else. Independent of `searxngEnabled()`.
 */
export function webPricingEnabled(): boolean {
  const v = (process.env.TRIPGENIE_WEB_PRICING_ENABLED ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/** Default contact placed in the Wikimedia User-Agent (Req 11.4). */
const DEFAULT_WIKIMEDIA_CONTACT = "https://github.com/justsehwag/TripGenie";

/**
 * Contact string for the Wikimedia `User-Agent`. Read on every call from
 * `TRIPGENIE_WIKIMEDIA_CONTACT` (trimmed); an unset or blank value falls back to
 * the project repository URL. Not secret.
 */
export function wikimediaContact(): string {
  const v = (process.env.TRIPGENIE_WIKIMEDIA_CONTACT ?? "").trim();
  return v === "" ? DEFAULT_WIKIMEDIA_CONTACT : v;
}
