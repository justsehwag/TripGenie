// Safe structured logging. Redacts sensitive keys and JWT-shaped strings.
// Request/response bodies must never be passed here.

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /token|cookie|authorization|code|email|password/i;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const MAX_DEPTH = 4;

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return value.replace(JWT_SHAPE, REDACTED);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

/** Returns a redacted copy of the fields (exported for tests). */
export function redactFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return redactValue(fields, 0) as Record<string, unknown>;
}

export function logSafe(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({ event: String(event).replace(JWT_SHAPE, REDACTED), ...redactFields(fields) });
    console.log(line);
  } catch {
    console.log(JSON.stringify({ event: "log_error" }));
  }
}
