/**
 * postBatch timeout behaviour (planner-stuck-loading, Requirements 2.5, 3.7).
 * Fake timers + an injected fetch; nothing touches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { postBatch } from "@/lib/itinerary/batch-client";
import { unavailable } from "@/lib/itinerary/batch-wire";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";
import { BATCH_CLIENT_TIMEOUT_MS } from "@/lib/itinerary/constants";

const req = {
  action: "itinerary-batch",
  context: { destination: "Goa" },
  fromDay: 1,
  dayCount: 2,
  usedPlaces: [],
} as unknown as BatchRequest;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A fetch that never settles; records the signal it was given. */
function hangingFetch() {
  const seen: { signal?: AbortSignal } = {};
  const fetchImpl: Fetch = (_input, init) => {
    seen.signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  };
  return { fetchImpl, seen };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("postBatch timeout", () => {
  it("returns null after exactly BATCH_CLIENT_TIMEOUT_MS for a never-resolving fetch", async () => {
    const { fetchImpl } = hangingFetch();
    let settled = false;
    const p = postBatch(req, new AbortController().signal, fetchImpl).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(BATCH_CLIENT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(p).resolves.toBeNull();
  });

  it("honours a custom timeoutMs", async () => {
    const { fetchImpl } = hangingFetch();
    let settled = false;
    const p = postBatch(req, new AbortController().signal, fetchImpl, 1234).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(1233);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(p).resolves.toBeNull();
  });

  it("aborts the signal handed to fetch on timeout", async () => {
    const { fetchImpl, seen } = hangingFetch();
    const p = postBatch(req, new AbortController().signal, fetchImpl, 500);

    await vi.advanceTimersByTimeAsync(499);
    expect(seen.signal).toBeDefined();
    expect(seen.signal!.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(seen.signal!.aborted).toBe(true);
    await expect(p).resolves.toBeNull();
  });

  it("clears the timer after a fast response", async () => {
    const body = unavailable({ fromDay: 1, dayCount: 2 }, "unavailable");
    const fetchImpl: Fetch = async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const result = await postBatch(req, new AbortController().signal, fetchImpl);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null without waiting when the caller signal is already aborted", async () => {
    const { fetchImpl } = hangingFetch();
    const ctl = new AbortController();
    ctl.abort();

    // No timer advancement: it must settle on its own.
    await expect(postBatch(req, ctl.signal, fetchImpl)).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  // Feature: planner-stuck-loading, Property 1: Bug Condition - Generation always reaches a terminal state
  it("property: any timeoutMs yields null once elapsed, never earlier", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 60_000 }), async (timeoutMs) => {
        const { fetchImpl, seen } = hangingFetch();
        let settled = false;
        const p = postBatch(req, new AbortController().signal, fetchImpl, timeoutMs).then((r) => {
          settled = true;
          return r;
        });

        await vi.advanceTimersByTimeAsync(timeoutMs - 1);
        const earlySettled = settled;

        await vi.advanceTimersByTimeAsync(1);
        const result = await p;

        return (
          earlySettled === false &&
          result === null &&
          seen.signal?.aborted === true &&
          vi.getTimerCount() === 0
        );
      }),
      { numRuns: 100 },
    );
  });
});
