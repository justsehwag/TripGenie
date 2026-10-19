import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  memoryKey,
  userIdFromMemoryKey,
  childSpan,
  traceWellPropagated,
  structuredLog,
  ttlAt,
  ttlExpired,
  type Span,
} from "@/lib/observability";

/** Feature: tripgenie - observability + data lifecycle (Property 42 + trace + TTL). */

describe("Feature: tripgenie, observability", () => {
  it("Property 42: Agent memory is scoped to the stable user identifier", () => {
    fc.assert(
      fc.property(fc.string().filter((s) => s.trim().length > 0), (raw) => {
        const uid = raw.trim();
        const key = memoryKey(uid);
        // The key encodes exactly this user's id; different users never collide.
        expect(userIdFromMemoryKey(key)).toBe(uid);
        expect(key.startsWith("tripgenie#")).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("distinct users get distinct memory keys", () => {
    expect(memoryKey("u1")).not.toBe(memoryKey("u2"));
    expect(() => memoryKey("  ")).toThrow();
  });

  it("trace spans propagate one traceId through the call chain (Req 18.2)", () => {
    const root: Span = { traceId: "t-1", spanId: "s-gw", name: "api-gateway" };
    const lambda = childSpan(root, "lambda", "s-fn");
    const ctrl = childSpan(lambda, "controller", "s-ctrl");
    const mcp = childSpan(ctrl, "mcp-tool", "s-mcp");
    const spans = [root, lambda, ctrl, mcp];
    expect(traceWellPropagated(spans)).toBe(true);
    for (const s of spans) expect(s.traceId).toBe("t-1");
    // A span with a dangling parent breaks propagation.
    expect(traceWellPropagated([...spans, { traceId: "t-1", spanId: "s-x", parentSpanId: "missing", name: "orphan" }])).toBe(false);
  });

  it("structured logs carry trace and user context (Req 18.1)", () => {
    const log = structuredLog("info", "booked", { traceId: "t-9", userId: "u1" });
    expect(log.traceId).toBe("t-9");
    expect(log.userId).toBe("u1");
    expect(log.level).toBe("info");
  });

  it("session/draft TTL expires on schedule (Req 20.2)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), fc.integer({ min: 1, max: 86400 }), (nowMs, ttlSec) => {
        const ttl = ttlAt(nowMs, ttlSec);
        // Not yet expired at creation time...
        expect(ttlExpired(ttl, nowMs)).toBe(false);
        // ...but expired once the TTL window has fully passed.
        expect(ttlExpired(ttl, nowMs + (ttlSec + 1) * 1000)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
