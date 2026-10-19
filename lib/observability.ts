/**
 * Observability + data lifecycle - design sections "Observability" / "Memory".
 * Pure helpers for structured logging, OTel trace propagation, AgentCore
 * Memory key scoping (stable user id), and session/draft TTL lifecycle so the
 * invariants (Property 42 + TTL) are testable offline. Live X-Ray/AgentCore
 * Observability delivery is verified at deploy time (Task 25.4).
 * Requirements: 18.1, 18.2, 18.3, 20.2, 20.3.
 */

/** Structured log record emitted by every Lambda/API Gateway stage (Req 18.1). */
export interface LogRecord {
  level: "info" | "warn" | "error";
  msg: string;
  traceId: string;
  userId: string;
  at: string;
}

export function structuredLog(
  level: LogRecord["level"],
  msg: string,
  ctx: { traceId: string; userId: string; at?: string },
): LogRecord {
  return {
    level,
    msg,
    traceId: ctx.traceId,
    userId: ctx.userId,
    at: ctx.at ?? new Date(0).toISOString(),
  };
}

/** OTel span propagated through API Gateway -> Lambda -> controller -> MCP. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
}

/** Child span inherits the parent's traceId and points back at the parent (Req 18.2). */
export function childSpan(parent: Span, name: string, spanId: string): Span {
  return { traceId: parent.traceId, spanId, parentSpanId: parent.spanId, name };
}

/** A trace is well-propagated iff every span shares one traceId and every
 * non-root span points at a known parent. */
export function traceWellPropagated(spans: readonly Span[]): boolean {
  if (spans.length === 0) return true;
  const trace = spans[0].traceId;
  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    if (s.traceId !== trace) return false;
    if (s.parentSpanId !== undefined && !ids.has(s.parentSpanId)) return false;
  }
  return true;
}

/** AgentCore Memory key is scoped to the traveller's stable user id (Req 20.3). */
export function memoryKey(userId: string, namespace = "tripgenie"): string {
  const uid = userId.trim();
  if (!uid) throw new Error("memoryKey requires a non-empty stable user id");
  return `${namespace}#${uid}`;
}

/** Extract the user id encoded in a memory key. */
export function userIdFromMemoryKey(key: string): string {
  const i = key.indexOf("#");
  return i >= 0 ? key.slice(i + 1) : key;
}

/** Session/draft records carry a TTL (epoch seconds) for DynamoDB native sweep. */
export function ttlAt(nowMs: number, ttlSeconds: number): number {
  return Math.floor(nowMs / 1000) + Math.max(0, Math.trunc(ttlSeconds));
}

/** True iff a record's TTL has passed (eligible for the TTL sweep). */
export function ttlExpired(ttl: number, nowMs: number): boolean {
  return ttl <= Math.floor(nowMs / 1000);
}
