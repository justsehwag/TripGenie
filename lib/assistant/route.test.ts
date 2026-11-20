import { describe, expect, it, vi } from "vitest";
import { createAssistantHandler } from "./route-handler";
import { createLimiter } from "./rate-limit";
import { MAX_BODY_BYTES } from "./wire";

const SENTINEL = "ZXQ-SENTINEL-7f3a91";

const itinerary = {
  title: "Trip",
  totalCost: 100,
  days: [
    {
      day: 1,
      date: "2025-01-01",
      title: "Day 1",
      theme: "Sights",
      total: 100,
      activities: [{ time: "09:00", title: "Fort", description: "A fort", cost: 100 }],
    },
  ],
};

function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ message: "hello", itinerary, ...over });
}

function req(text: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: text,
  });
}

const OK_OUT = {
  response: { reply: "ok", proposals: [], sources: [], degraded: [] },
  counters: { modelCalls: 1, toolCalls: 0 },
};

function setup(runLoopImpl?: () => Promise<unknown>) {
  const converse = vi.fn();
  const runLoop = vi.fn(runLoopImpl ?? (async () => OK_OUT));
  const log = vi.fn();
  const limiter = createLimiter({ max: 20, windowMs: 60_000 });
  const handler = createAssistantHandler({
    limiter,
    converse: converse as never,
    runLoop: runLoop as never,
    log,
  });
  return { handler, converse, runLoop, log };
}

function noStore(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
}

describe("POST /api/assistant handler", () => {
  it("200 passes the loop response through", async () => {
    const { handler, runLoop } = setup();
    const res = await handler(req(body()));
    expect(res.status).toBe(200);
    noStore(res);
    expect(await res.json()).toEqual(OK_OUT.response);
    expect(runLoop).toHaveBeenCalledTimes(1);
  });

  it("400 for bad JSON without calling converse or runLoop", async () => {
    const { handler, converse, runLoop } = setup();
    const res = await handler(req("{not json"));
    expect(res.status).toBe(400);
    noStore(res);
    expect(converse).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
  });

  it("400 for a message over 1000 characters", async () => {
    const { handler, converse, runLoop } = setup();
    const res = await handler(req(body({ message: "a".repeat(1001) })));
    expect(res.status).toBe(400);
    noStore(res);
    expect(converse).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
  });

  it("400 for a missing itinerary", async () => {
    const { handler, converse, runLoop } = setup();
    const res = await handler(req(JSON.stringify({ message: "hello" })));
    expect(res.status).toBe(400);
    noStore(res);
    expect(converse).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
  });

  it("413 when content-length is over 256 KB", async () => {
    const { handler, converse, runLoop } = setup();
    const res = await handler(req(body(), { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(res.status).toBe(413);
    noStore(res);
    expect(converse).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
  });

  it("413 for an actual large body without a content-length header", async () => {
    const { handler, converse, runLoop } = setup();
    const text = body({ pad: "x".repeat(MAX_BODY_BYTES + 10) });
    const r = req(text);
    r.headers.delete("content-length");
    const res = await handler(r);
    expect(res.status).toBe(413);
    noStore(res);
    expect(converse).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
  });

  it("429 on the 21st request in a minute with Retry-After; other IP still allowed", async () => {
    const { handler } = setup();
    const ip = { "x-forwarded-for": "10.0.0.1" };
    for (let i = 0; i < 20; i++) {
      const ok = await handler(req(body(), ip));
      expect(ok.status).toBe(200);
    }
    const res = await handler(req(body(), ip));
    expect(res.status).toBe(429);
    noStore(res);
    const retry = Number(res.headers.get("Retry-After"));
    expect(Number.isFinite(retry)).toBe(true);
    expect(retry).toBeGreaterThan(0);

    const other = await handler(req(body(), { "x-forwarded-for": "10.0.0.2" }));
    expect(other.status).toBe(200);
  });

  it("500 with a generic body when runLoop throws, and no-store", async () => {
    const { handler } = setup(async () => {
      throw new Error(`boom ${SENTINEL}`);
    });
    const res = await handler(req(body({ message: SENTINEL })));
    expect(res.status).toBe(500);
    noStore(res);
    const text = await res.text();
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("boom");
    expect(JSON.parse(text)).toEqual({ error: "Something went wrong." });
  });

  it("never logs the message text on success or error paths", async () => {
    const ok = setup();
    await ok.handler(req(body({ message: SENTINEL })));
    const bad = setup(async () => {
      throw new Error(`boom ${SENTINEL}`);
    });
    await bad.handler(req(body({ message: SENTINEL })));
    const invalid = setup();
    await invalid.handler(req(body({ message: SENTINEL, itinerary: null })));
    for (const s of [ok, bad, invalid]) {
      expect(s.log).toHaveBeenCalled();
      for (const call of s.log.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SENTINEL);
      }
    }
  });
});
