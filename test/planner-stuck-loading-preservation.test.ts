import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { postBatch } from "@/lib/itinerary/batch-client";
import { unavailable } from "@/lib/itinerary/batch-wire";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";
import type { TripContext } from "@/lib/types";

// Feature: planner-stuck-loading, Property 2: Preservation - Real unmount, superseding and success are unchanged
// Observation-first: these postBatch behaviors hold on unfixed code and must keep holding after the fix.

const req: BatchRequest = {
  action: "itinerary-batch",
  context: { destination: "Goa", durationDays: 3 } as unknown as TripContext,
  fromDay: 1,
  dayCount: 3,
  usedPlaces: [],
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fetch that never answers on its own and rejects once its signal aborts. */
function hangingFetch(): FetchLike {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const s = init?.signal;
      if (!s) return;
      const fail = () => reject(new DOMException("Aborted", "AbortError"));
      if (s.aborted) fail();
      else s.addEventListener("abort", fail, { once: true });
    });
}

describe("postBatch preservation", () => {
  it("returns the parsed value for a fast valid response", async () => {
    const body = unavailable(req, "unavailable", 12);
    const fetchImpl: FetchLike = async () => jsonResponse(body);
    const out = await postBatch(req, new AbortController().signal, fetchImpl);
    expect(out).not.toBeNull();
    expect(out?.source).toBe("unavailable");
    expect(out?.reason).toBe("unavailable");
    expect(out?.fromDay).toBe(1);
    expect(out?.dayCount).toBe(3);
    expect(out?.withheldDays).toEqual([1, 2, 3]);
  });

  it("returns null for an unreadable body", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ nope: true });
    expect(await postBatch(req, new AbortController().signal, fetchImpl)).toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network");
    };
    expect(await postBatch(req, new AbortController().signal, fetchImpl)).toBeNull();
  });

  it("returns null when the caller's signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    expect(await postBatch(req, c.signal, hangingFetch())).toBeNull();
  });

  it("returns null when the caller aborts while the request is pending", async () => {
    const c = new AbortController();
    const p = postBatch(req, c.signal, hangingFetch());
    c.abort();
    expect(await p).toBeNull();
  });

  it("property: any non-ok status returns null", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 300, max: 599 }), async (status) => {
        const fetchImpl: FetchLike = async () =>
          jsonResponse(unavailable(req, "unavailable"), status);
        // 3xx statuses other than 200-299 are not ok either
        const res = await postBatch(req, new AbortController().signal, fetchImpl);
        expect(res).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("property: aborting the caller's signal after any number of ticks returns null", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (ticks) => {
        const c = new AbortController();
        const p = postBatch(req, c.signal, hangingFetch());
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        c.abort();
        expect(await p).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("property: a valid response for any reason and range round-trips", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("not-configured", "unavailable", "unverified" as const),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 3 }),
        async (reason, fromDay, dayCount) => {
          const r = { fromDay, dayCount };
          const body = unavailable(r, reason as "unavailable");
          const fetchImpl: FetchLike = async () => jsonResponse(body);
          const out = await postBatch(req, new AbortController().signal, fetchImpl);
          expect(out).toEqual(body);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Lifecycle preservation (appended once generation-lifecycle helper existed)
import { vi } from "vitest";
import { classifyExit, scheduleUnmountAbort } from "@/lib/itinerary/generation-lifecycle";

describe("generation lifecycle preservation", () => {
  it("a real unmount aborts exactly once", () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn();
      let mounted = true;
      mounted = false; // component really unmounted
      scheduleUnmountAbort(() => mounted, abort);
      expect(abort).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("property: superseded always classifies as silent, never failure", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (aborted, generationActive, unmounted) => {
        const kind = classifyExit({ aborted, generationActive, superseded: true, unmounted });
        expect(kind).toBe("silent");
        expect(kind).not.toBe("failure");
      }),
      { numRuns: 100 },
    );
  });
});
