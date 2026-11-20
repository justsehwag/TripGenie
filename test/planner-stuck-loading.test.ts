import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import * as constants from "@/lib/itinerary/constants";
import { postBatch } from "@/lib/itinerary/batch-client";
import type { BatchRequest } from "@/lib/itinerary/batch-wire";

// Feature: planner-stuck-loading, Property 1: Bug Condition - Generation always reaches a terminal state
// Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5

// BATCH_CLIENT_TIMEOUT_MS does not exist on unfixed code; fall back so the postBatch case is still meaningful.
const TIMEOUT_MS: number =
  (constants as unknown as { BATCH_CLIENT_TIMEOUT_MS?: number }).BATCH_CLIENT_TIMEOUT_MS ?? 30_000;

// Dynamic import so a missing helper module fails each test (not the whole file at collection).
async function loadLifecycle() {
  return await import("@/lib/itinerary/generation-lifecycle");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Property 1: Bug Condition - Generation always reaches a terminal state", () => {
  it("classifyExit is never silent when not superseded and not unmounted", async () => {
    const { classifyExit } = await loadLifecycle();
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (aborted, generationActive) => {
        const exit = classifyExit({ aborted, generationActive, superseded: false, unmounted: false });
        expect(exit).not.toBe("silent");
        if (aborted || !generationActive) expect(exit).toBe("failure");
      }),
      { numRuns: 100 },
    );
  });

  it("Strict Mode simulated unmount (remount before the scheduled callback) never aborts", async () => {
    const { scheduleUnmountAbort } = await loadLifecycle();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), () => {
        let mounted = true;
        const abort = vi.fn();
        let pending: (() => void) | null = null;
        mounted = false; // simulated cleanup
        scheduleUnmountAbort(
          () => mounted,
          abort,
          (fn: () => void) => {
            pending = fn;
          },
        );
        mounted = true; // remount effect runs before the timer
        (pending as (() => void) | null)?.();
        expect(abort).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it("postBatch with a never-resolving fetch returns null after BATCH_CLIENT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const neverFetch = () => new Promise<Response>(() => {});
    const controller = new AbortController();
    const req = {} as unknown as BatchRequest;
    const outcome = postBatch(req, controller.signal, neverFetch);
    const SENTINEL = Symbol("hung");
    const raced = Promise.race([
      outcome,
      new Promise<symbol>((resolve) => {
        // Real-time-independent guard: resolves one tick after fake timers advance.
        setTimeout(() => resolve(SENTINEL), TIMEOUT_MS + 1000);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await raced;
    expect(result).toBeNull();
  });
});
