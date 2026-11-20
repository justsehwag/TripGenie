import { describe, it, expect } from "vitest";
import { runPlanner, type PlanRunDeps } from "../lib/itinerary/plan-run";
import { buildPlannerInput } from "../lib/itinerary/planner";
import type { PlanContext } from "../lib/itinerary/plan-check";
import { dayLimits } from "../lib/itinerary/pace";
import type { DaySpec } from "../lib/itinerary/scheduler";
import type { PlaceCandidate } from "../lib/providers/google-places";
import type { ModelPrompt } from "../lib/bedrock-model";

function cand(id: string, name: string): PlaceCandidate {
  return {
    placeId: id,
    name,
    address: "1 Road, Old Town, France",
    location: { lat: 0.001 * id.charCodeAt(id.length - 1), lng: 0 },
    rating: 4,
    userRatingCount: 100,
    hours: null,
    utcOffsetMinutes: null,
    types: [],
    primaryType: "tourist_attraction",
    businessStatus: "OPERATIONAL",
    googleMapsUri: null,
    photos: [],
  };
}

function spec(n: number): DaySpec {
  return { day: n, date: null, weekday: null, limits: dayLimits("balanced", n, 2), earliestMin: 540 };
}

const SENT = [cand("a1", "Alpha Fort"), cand("a2", "Beta Garden")];
const CTX: PlanContext = {
  days: [{ spec: spec(1), deterministicCount: 2 }],
  sent: SENT,
  dates: ["2025-01-06"],
};
const INPUT = buildPlannerInput([spec(1)], SENT, "Paris");

const GOOD = {
  days: [
    {
      day: 1,
      startTime: "09:30",
      title: "Old Town walk",
      stops: [
        { placeId: "a1", sentence: "Start with the old walls." },
        { placeId: "a2", sentence: "Then a quiet green space." },
      ],
    },
  ],
};

const MARKER = "ZEBRAMARKER";
const BAD_TEXT = {
  days: [
    {
      day: 1,
      startTime: "09:30",
      title: `${MARKER} title`,
      stops: [
        { placeId: "a1", sentence: `${MARKER} entry costs 500 rupees.` },
        { placeId: "a2", sentence: "Then a quiet green space." },
      ],
    },
  ],
};
const BAD_IDS = {
  days: [
    {
      day: 1,
      startTime: "09:30",
      title: "Old Town walk",
      stops: [
        { placeId: "ghost-id-XYZ", sentence: `${MARKER} sentence.` },
        { placeId: "a2", sentence: "Then a quiet green space." },
      ],
    },
  ],
};

const json = (v: unknown) => JSON.stringify(v);

/** Clock at 0, deadline `budget` ms away. Replies are consumed in order; a function reply may throw. */
function harness(replies: Array<string | (() => string | Promise<string>)>, budget = 20_000, withModel = true) {
  const prompts: ModelPrompt[] = [];
  let i = 0;
  const deps: PlanRunDeps = {
    now: () => 0,
    deadline: budget,
    invokeModel: withModel
      ? async (p: ModelPrompt) => {
          prompts.push(p);
          const r = replies[Math.min(i++, replies.length - 1)];
          return typeof r === "function" ? await r() : r;
        }
      : undefined,
  };
  return { deps, prompts };
}

describe("runPlanner", () => {
  it("falls back with repaired 0 when no invokeModel is given", async () => {
    const { deps, prompts } = harness([], 20_000, false);
    expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "fallback", repaired: 0, applied: null });
    expect(prompts).toHaveLength(0);
  });

  it("falls back when the time left is below the minimum step", async () => {
    // left = budget - 4000 reserve; 4500 budget leaves 500 < 800
    const { deps, prompts } = harness([json(GOOD)], 4_500);
    expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "fallback", repaired: 0, applied: null });
    expect(prompts).toHaveLength(0);
  });

  it("falls back with no repair when the first call throws", async () => {
    const { deps, prompts } = harness([
      () => {
        throw new Error("boom");
      },
    ]);
    expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "fallback", repaired: 0, applied: null });
    expect(prompts).toHaveLength(1);
  });

  it("falls back with no repair when the first call rejects asynchronously", async () => {
    const { deps, prompts } = harness([() => Promise.reject(new Error("net"))]);
    const r = await runPlanner(CTX, INPUT, deps);
    expect(r).toEqual({ state: "fallback", repaired: 0, applied: null });
    expect(prompts).toHaveLength(1);
  });

  it.each([["not json at all"], [""], ["   "], ["[1,2]"]])(
    "falls back with no repair on garbage reply %j",
    async (garbage) => {
      const { deps, prompts } = harness([garbage, json(GOOD)]);
      expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "fallback", repaired: 0, applied: null });
      expect(prompts).toHaveLength(1);
    },
  );

  it("accepts a valid first plan without repair", async () => {
    const { deps, prompts } = harness([json(GOOD)]);
    const r = await runPlanner(CTX, INPUT, deps);
    expect(r.state).toBe("accepted");
    expect(r.repaired).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(r.applied?.days).toHaveLength(1);
    expect(r.applied?.days[0].stops.map((s) => s.candidate.placeId)).toEqual(["a1", "a2"]);
    expect(r.applied?.days[0].stops.every((s) => s.scheduled !== null)).toBe(true);
  });

  it("accepts model text wrapped in a code fence", async () => {
    const { deps } = harness(["```json\n" + json(GOOD) + "\n```"]);
    const r = await runPlanner(CTX, INPUT, deps);
    expect(r.state).toBe("accepted");
  });

  it("repairs once after a rejected first plan and accepts the repair", async () => {
    const { deps, prompts } = harness([json(BAD_TEXT), json(GOOD)]);
    const r = await runPlanner(CTX, INPUT, deps);
    expect(r.state).toBe("accepted");
    expect(r.repaired).toBe(1);
    expect(r.applied).not.toBeNull();
    expect(prompts).toHaveLength(2);
  });

  it("rejects with repaired 1 when the repair is also rejected", async () => {
    const { deps, prompts } = harness([json(BAD_TEXT), json(BAD_TEXT)]);
    expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "rejected", repaired: 1, applied: null });
    expect(prompts).toHaveLength(2);
  });

  it("rejects with repaired 1 when the repair call fails", async () => {
    const { deps, prompts } = harness([
      json(BAD_TEXT),
      () => {
        throw new Error("boom");
      },
    ]);
    expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "rejected", repaired: 1, applied: null });
    expect(prompts).toHaveLength(2);
  });

  it("rejects with repaired 1 when the repair returns garbage", async () => {
    const { deps } = harness([json(BAD_TEXT), "nope"]);
    expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "rejected", repaired: 1, applied: null });
  });

  it("never makes a third call", async () => {
    const { deps, prompts } = harness([json(BAD_TEXT)]);
    await runPlanner(CTX, INPUT, deps);
    expect(prompts).toHaveLength(2);
  });

  it("rejects with repaired 0 when no time is left for a repair", async () => {
    // left = 7500 - 4000 = 3500: enough for the first call, below the 4000 repair timeout
    const { deps, prompts } = harness([json(BAD_TEXT), json(GOOD)], 7_500);
    expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "rejected", repaired: 0, applied: null });
    expect(prompts).toHaveLength(1);
  });

  it("uses the clock after the first call to decide on the repair", async () => {
    let t = 0;
    const prompts: ModelPrompt[] = [];
    const deps: PlanRunDeps = {
      now: () => t,
      deadline: 12_000, // left at start 8000, so a repair fits only if the first call is quick
      invokeModel: async (p) => {
        prompts.push(p);
        t += 5_000; // first call is slow: left becomes 3000 < 4000
        return json(BAD_TEXT);
      },
    };
    expect(await runPlanner(CTX, INPUT, deps)).toEqual({ state: "rejected", repaired: 0, applied: null });
    expect(prompts).toHaveLength(1);
  });

  it("caps the first timeout at min(7000, left)", async () => {
    const big = harness([json(GOOD)], 60_000);
    await runPlanner(CTX, INPUT, big.deps);
    expect(big.prompts[0].timeoutMs).toBe(7_000);

    const small = harness([json(GOOD)], 6_000); // left 2000
    await runPlanner(CTX, INPUT, small.deps);
    expect(small.prompts[0].timeoutMs).toBe(2_000);
  });

  it("caps the repair timeout at min(4000, left)", async () => {
    const big = harness([json(BAD_TEXT), json(GOOD)], 60_000);
    await runPlanner(CTX, INPUT, big.deps);
    expect(big.prompts[1].timeoutMs).toBe(4_000);

    // left exactly 4000 at repair time
    const edge = harness([json(BAD_TEXT), json(GOOD)], 8_000);
    await runPlanner(CTX, INPUT, edge.deps);
    expect(edge.prompts[1].timeoutMs).toBe(4_000);
  });

  describe("repair prompt", () => {
    it.each([
      ["text rejection", BAD_TEXT],
      ["unknown id rejection", BAD_IDS],
    ])("never echoes the rejected output (%s)", async (_n, bad) => {
      const { deps, prompts } = harness([json(bad), json(GOOD)]);
      await runPlanner(CTX, INPUT, deps);
      const repair = prompts[1];
      const all = `${repair.system}\n${repair.user}`;
      expect(all).not.toContain(MARKER);
      expect(all).not.toContain("ghost-id-XYZ");
      expect(all).not.toContain("costs 500");
    });

    it("carries the input plus only reason, day numbers and sent placeIds", async () => {
      const { deps, prompts } = harness([json(BAD_TEXT), json(GOOD)]);
      await runPlanner(CTX, INPUT, deps);
      const parsed = JSON.parse(prompts[1].user) as Record<string, unknown> & {
        feedback: { reason: string; days: number[]; placeIds: string[]; instruction: string };
      };
      expect(parsed.destination).toBe("Paris");
      expect(parsed.candidates).toEqual(INPUT.candidates);
      expect(parsed.feedback.reason).toBe("text");
      expect(parsed.feedback.days).toEqual([1]);
      const sentIds = new Set(SENT.map((c) => c.placeId));
      expect(parsed.feedback.placeIds.every((p) => sentIds.has(p))).toBe(true);
      expect(Object.keys(parsed.feedback).sort()).toEqual(["days", "instruction", "placeIds", "reason"]);
    });

    it("lists no unknown placeId for an ids rejection", async () => {
      const { deps, prompts } = harness([json(BAD_IDS), json(GOOD)]);
      await runPlanner(CTX, INPUT, deps);
      const fb = (JSON.parse(prompts[1].user) as { feedback: { reason: string; placeIds: string[] } }).feedback;
      expect(fb.reason).toBe("ids");
      expect(fb.placeIds).not.toContain("ghost-id-XYZ");
    });
  });

  describe("never throws", () => {
    it("survives a synchronous throw from invokeModel", async () => {
      const deps: PlanRunDeps = {
        now: () => 0,
        deadline: 20_000,
        invokeModel: (() => {
          throw new Error("sync");
        }) as PlanRunDeps["invokeModel"],
      };
      await expect(runPlanner(CTX, INPUT, deps)).resolves.toEqual({
        state: "fallback",
        repaired: 0,
        applied: null,
      });
    });

    it("survives a throwing clock", async () => {
      const deps: PlanRunDeps = {
        now: () => {
          throw new Error("clock");
        },
        deadline: 20_000,
        invokeModel: async () => json(GOOD),
      };
      const r = await runPlanner(CTX, INPUT, deps);
      expect(r).toEqual({ state: "fallback", repaired: 0, applied: null });
    });

    it("survives a malformed context and non-finite deadline", async () => {
      const { deps } = harness([json(GOOD)]);
      await expect(runPlanner(null as unknown as PlanContext, INPUT, deps)).resolves.toBeDefined();
      await expect(
        runPlanner(CTX, INPUT, { ...deps, deadline: Number.NaN }),
      ).resolves.toEqual({ state: "fallback", repaired: 0, applied: null });
    });

    it("survives a non-string model reply", async () => {
      const deps: PlanRunDeps = {
        now: () => 0,
        deadline: 20_000,
        invokeModel: (async () => 42) as unknown as PlanRunDeps["invokeModel"],
      };
      await expect(runPlanner(CTX, INPUT, deps)).resolves.toMatchObject({ repaired: 0 });
    });
  });
});
