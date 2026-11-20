// Account-sync environment helpers. Every value is read from process.env at
// call time (never cached in module constants) so tests can stub the env.

const DEFAULT_SESSION_DAYS = 30;
const MAX_SESSION_DAYS = 3650;

function read(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** True when both DynamoDB table names are set. */
export function accountStorageConfigured(): boolean {
  return read("TRIPGENIE_TRIPS_TABLE") !== "" && read("TRIPGENIE_PROFILES_TABLE") !== "";
}

export function tripsTableName(): string {
  return read("TRIPGENIE_TRIPS_TABLE");
}

export function profilesTableName(): string {
  return read("TRIPGENIE_PROFILES_TABLE");
}

/** Region for DynamoDB, or undefined when not set. */
export function dynamoRegion(): string | undefined {
  return read("TRIPGENIE_DYNAMO_REGION") || undefined;
}

/**
 * Allowed browser origins from TRIPGENIE_APP_ORIGIN (comma separated).
 * Each entry is normalized with `new URL(...).origin`; invalid entries are dropped.
 */
export function allowedOrigins(): string[] {
  const out: string[] = [];
  for (const part of read("TRIPGENIE_APP_ORIGIN").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    try {
      const origin = new URL(entry).origin;
      if (origin !== "null" && !out.includes(origin)) out.push(origin);
    } catch {
      // invalid entry: dropped
    }
  }
  return out;
}

/**
 * Whether cookies should use the Secure attribute / __Host- prefix.
 * Decided from the first configured app origin, else the optional request URL.
 * With neither available it defaults to secure.
 */
export function isSecureOrigin(requestUrl?: string): boolean {
  const first = allowedOrigins()[0];
  const source = first ?? requestUrl;
  if (!source) return true;
  try {
    return new URL(source).protocol === "https:";
  } catch {
    return true;
  }
}

/**
 * Session cookie lifetime in seconds: TRIPGENIE_SESSION_MAX_DAYS (default 30)
 * minus the time elapsed since `authTime` (epoch seconds) when given. Never negative.
 */
export function sessionMaxSeconds(authTime?: number, nowMs: number = Date.now()): number {
  const raw = Number(read("TRIPGENIE_SESSION_MAX_DAYS"));
  const days =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_SESSION_DAYS) : DEFAULT_SESSION_DAYS;
  const total = Math.floor(days * 86400);
  if (typeof authTime !== "number" || !Number.isFinite(authTime) || authTime <= 0) return total;
  const elapsed = Math.max(0, Math.floor(nowMs / 1000 - authTime));
  return Math.max(0, total - elapsed);
}

/** Returns the Cognito hosted-UI domain (host only) when set and well formed, else undefined. */
export function validCognitoDomain(): string | undefined {
  const domain = read("COGNITO_DOMAIN");
  return /^[a-z0-9.-]+$/.test(domain) ? domain : undefined;
}
