import { describe, expect, it } from "vitest";
import type { PlaceCandidate } from "@/lib/providers/google-places";
import type { DaySpec } from "@/lib/itinerary/scheduler";
import {
  buildPlannerInput,
  buildPlannerPrompt,
  buildRepairPrompt,
  plannerTimeoutMs,
  repairTimeoutMs,
  runPlannerCall,
  selectPlannerCandidates,
} from "@/lib/itinerary/planner";
import {
  PLANNER_CANDIDATES_PER_BATCH,
  PLANNER_REPAIR_TIMEOUT_MS,
  PLANNER_TIMEOUT_MS,
} from "@/lib/itinerary/constants";
import { SYSTEM_PROMPT_PREFIX } from "@/lib/system-prompt";

function cand(i: number, over: Partial<PlaceCandidate> = {}): PlaceCandidate {
  return {
    placeId: `p${i}`,
    name: `Place ${i}`,
    address: `${i} Secret Road`,
    location: { lat: 10 + i / 100, lng: 20 + i / 100 },
    rating: 4.5,
    userRatingCount: 100,
    hours: { periods: [], weekdayDescriptions: ["Monday: 9:00 AM - 5:00 PM"] },
    utcOffsetMinutes: 0,
    types: ["tourist_attraction"],
    primaryType: "tourist_attraction",
    businessStatus: "OPERATIONAL",
    googleMapsUri: "https://maps.google.com/?cid=1",
    photos: ["places/x/photos/y"],
    ...over,
  };
}

const spec = (day: number, weekday: number | null = 1): DaySpec => ({
  day,
  date: weekday === null ? null : "2025-01-06",
  weekday,
  limits: { target: 4, min: 3, max: 5, partial: false },
  earliestMin: 570,
});

describe("selectPlannerCandidates", () => {
  const many = Array.from({ length: 60 }, (_, i) => cand(i));
  it("caps at 12 per day and 36 per batch, keeping order", () => {
    expect(selectPlannerCandidates(many, 1).map((c) => c.placeId)).toEqual(
      many.slice(0, 12).map((c) => c.placeId),
    );
    expect(selectPlannerCandidates(many, 3)).toHaveLength(PLANNER_CANDIDATES_PER_BATCH);
    expect(selectPlannerCandidates(many, 5)).toHaveLength(PLANNER_CANDIDATES_PER_BATCH);
  });
  it("leaves out URL-like names", () => {
    const list = [cand(1, { name: "https://spam.example" }), cand(2, { name: "www.deals.com" }), cand(3, { name: "best-hotel.com" }), cand(4)];
    expect(selectPlannerCandidates(list, 1).map((c) => c.placeId)).toEqual(["p4"]);
  });
  it("never throws on bad input", () => {
    expect(selectPlannerCandidates(null as never, 2)).toEqual([]);
    expect(selectPlannerCandidates(many, Number.NaN)).toEqual([]);
  });
});

describe("buildPlannerInput and prompt", () => {
  it("sends only the named candidate fields and an hours summary", () => {
    const input = buildPlannerInput([spec(1), spec(2, null)], [cand(1), cand(2, { hours: null })], "Goa");
    expect(Object.keys(input.candidates[0]).sort()).toEqual(
      ["hours", "lat", "lng", "name", "placeId", "primaryType", "rating"].sort(),
    );
    expect(input.candidates[0].hours).toEqual(["Monday: 9:00 AM - 5:00 PM"]);
    expect(input.candidates[1].hours).toEqual(["hours not listed"]);
    expect(input.days[0]).toMatchObject({ day: 1, weekday: "Monday", earliestStart: "09:30", minStops: 3, maxStops: 5 });
    expect(input.days[1].weekday).toBeNull();
  });

  it("carries no address, url, photo or price in the prompt", () => {
    const dirty = cand(1, { name: "Fort" }) as PlaceCandidate & Record<string, unknown>;
    dirty.price = 4200;
    dirty.website = "https://example.org/x";
    dirty.phone = "+91 555";
    const p = buildPlannerPrompt(buildPlannerInput([spec(1)], [dirty], "Goa"), { timeoutMs: 1234 });
    const text = `${p.system}\n${p.user}`;
    expect(text).not.toMatch(/Secret Road|maps\.google|https?:\/\/|photos\/|4200|555|userRatingCount/);
    expect(text).not.toMatch(/confirmed|bookable/i);
    expect(p.system.startsWith(SYSTEM_PROMPT_PREFIX)).toBe(true);
    expect(p.timeoutMs).toBe(1234);
    expect(p.maxTokens).toBe(200 + 60 * 1 + 100 * 5);
  });
});

describe("buildRepairPrompt", () => {
  const input = buildPlannerInput([spec(1), spec(2)], [cand(1), cand(2)], "Goa");
  it("names only days, sent placeIds and a reason code", () => {
    const p = buildRepairPrompt(input, { reason: "feasibility", days: [2], placeIds: ["p1", "evil-id"] }, { timeoutMs: 900 });
    const user = JSON.parse(p.user);
    expect(user.feedback.reason).toBe("feasibility");
    expect(user.feedback.days).toEqual([2]);
    expect(user.feedback.placeIds).toEqual(["p1"]);
    expect(user.candidates).toHaveLength(2);
    expect(p.user).not.toMatch(/evil-id/);
    expect(p.timeoutMs).toBe(900);
  });
  it("falls back to a safe reason for an unknown code", () => {
    const p = buildRepairPrompt(input, { reason: "nope" as never, days: [], placeIds: [] }, { timeoutMs: 1 });
    expect(JSON.parse(p.user).feedback.reason).toBe("shape");
  });
});

describe("timeouts", () => {
  it("is min(cap, left) with the enrichment reserve held back", () => {
    expect(plannerTimeoutMs(25_000, 0)).toBe(PLANNER_TIMEOUT_MS);
    expect(repairTimeoutMs(25_000, 0)).toBe(PLANNER_REPAIR_TIMEOUT_MS);
    // left = 25000 - 15000 - 3000 - 500 - 500 = 6000
    expect(plannerTimeoutMs(25_000, 15_000)).toBe(6_000);
    expect(repairTimeoutMs(25_000, 15_000)).toBe(PLANNER_REPAIR_TIMEOUT_MS);
    expect(plannerTimeoutMs(25_000, 25_000)).toBeLessThan(0);
  });
});

describe("runPlannerCall", () => {
  const prompt = () =>
    buildPlannerPrompt(buildPlannerInput([spec(1)], [cand(1)], "Goa"), { timeoutMs: 50 });

  it("parses one JSON object and calls the model once", async () => {
    let calls = 0;
    const out = { days: [{ day: 1, startTime: "09:30", title: "T", stops: [{ placeId: "p1", sentence: "S." }] }] };
    const r = await runPlannerCall(
      { invokeModel: async () => { calls++; return `\`\`\`json\n${JSON.stringify(out)}\n\`\`\``; } },
      prompt(),
    );
    expect(r).toEqual({ ok: true, raw: out });
    expect(calls).toBe(1);
  });

  it("returns a typed failure on throw, empty, bad text, timeout and no time", async () => {
    expect(await runPlannerCall({ invokeModel: async () => { throw new Error("x"); } }, prompt())).toEqual({ ok: false });
    expect(await runPlannerCall({ invokeModel: async () => " " }, prompt())).toEqual({ ok: false });
    expect(await runPlannerCall({ invokeModel: async () => "nope" }, prompt())).toEqual({ ok: false });
    expect(await runPlannerCall({ invokeModel: () => new Promise<string>(() => {}) }, prompt())).toEqual({ ok: false });
    let calls = 0;
    expect(
      await runPlannerCall({ invokeModel: async () => { calls++; return "{}"; } }, { ...prompt(), timeoutMs: 0 }),
    ).toEqual({ ok: false });
    expect(calls).toBe(0);
    expect(await runPlannerCall({} as never, prompt())).toEqual({ ok: false });
  });
});
