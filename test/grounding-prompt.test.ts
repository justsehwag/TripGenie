import { describe, expect, it } from "vitest";
import {
  buildItineraryPrompt,
  generateItineraryAsync,
  generateItineraryDetailed,
  type ModelPrompt,
} from "../lib/bedrock-model";
import { SYSTEM_PROMPT_PREFIX } from "../lib/planning-turn";
import type { GroundingBundle, GroundingStatus } from "../lib/grounding/types";
import type { TripContext } from "../lib/types";

const CONTEXT = {
  destination: "Lisbon",
  durationDays: 3,
  budgetLevel: "mid",
  interests: ["food", "history"],
} as unknown as TripContext;

const LAST_RULE =
  "- Keep each activity description to one concrete sentence that references the real place.";
const SHAPE_START = "Return ONLY a single JSON object";

const BUNDLE: GroundingBundle = {
  status: "ok",
  droppedCount: 0,
  snippets: [
    {
      title: "Alfama walking guide",
      snippet: "Wander the narrow lanes of Alfama and visit the Sao Jorge Castle.",
      url: "https://example.com/alfama",
      host: "example.com",
    },
  ],
};

describe("buildItineraryPrompt with grounding", () => {
  it("places the block after the last rule and before the JSON shape", () => {
    const { system, user } = buildItineraryPrompt(CONTEXT, BUNDLE);
    const rule = system.indexOf(LAST_RULE);
    const block = system.indexOf("Alfama walking guide");
    const shape = system.indexOf(SHAPE_START);
    expect(rule).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(rule);
    expect(shape).toBeGreaterThan(block);
    expect(user).not.toContain("Alfama");
  });

  it("keeps SYSTEM_PROMPT_PREFIX first", () => {
    expect(buildItineraryPrompt(CONTEXT, BUNDLE).system.startsWith(SYSTEM_PROMPT_PREFIX)).toBe(true);
  });

  it.each<GroundingStatus>(["disabled", "empty", "unavailable"])(
    "is identical to the ungrounded prompt for status %s",
    (status) => {
      const bundle: GroundingBundle = { status, snippets: [], droppedCount: 0 };
      expect(buildItineraryPrompt(CONTEXT, bundle)).toEqual(buildItineraryPrompt(CONTEXT));
    },
  );

  it("is identical for undefined grounding", () => {
    expect(buildItineraryPrompt(CONTEXT, undefined)).toEqual(buildItineraryPrompt(CONTEXT));
  });
});

const MODEL_JSON = JSON.stringify({
  title: "Lisbon trip",
  days: [
    {
      day: 1,
      date: "2025-01-01",
      title: "Day 1",
      theme: "History",
      activities: [{ time: "09:00", title: "Visit Sao Jorge Castle", description: "Castle visit", cost: 15 }],
    },
  ],
});

describe("generateItineraryDetailed", () => {
  const now = () => Date.parse("2025-01-01T00:00:00Z");

  it("reports model on success", async () => {
    const res = await generateItineraryDetailed({ invokeModel: async () => MODEL_JSON, now }, CONTEXT);
    expect(res.source).toBe("model");
    expect(res.itinerary!.title).toBe("Lisbon trip");
  });

  it("reports unavailable on model error and on malformed output", async () => {
    const err = await generateItineraryDetailed(
      { invokeModel: async () => { throw new Error("boom"); }, now },
      CONTEXT,
    );
    expect(err.source).toBe("unavailable");
    expect(err.itinerary).toBeNull();
    const bad = await generateItineraryDetailed({ invokeModel: async () => "not json", now }, CONTEXT);
    expect(bad.source).toBe("unavailable");
    expect(bad.itinerary).toBeNull();
  });

  it("generateItineraryAsync returns the same itinerary as the detailed result", async () => {
    const ok = { invokeModel: async () => MODEL_JSON, now };
    expect(await generateItineraryAsync(ok, CONTEXT)).toEqual(
      (await generateItineraryDetailed(ok, CONTEXT)).itinerary,
    );
    const failing = { invokeModel: async () => { throw new Error("x"); }, now };
    expect(await generateItineraryAsync(failing, CONTEXT)).toEqual(
      (await generateItineraryDetailed(failing, CONTEXT)).itinerary,
    );
  });

  it("passes grounding snippets into the invoked system prompt only when given", async () => {
    const seen: ModelPrompt[] = [];
    const deps = {
      invokeModel: async (p: ModelPrompt) => {
        seen.push(p);
        return MODEL_JSON;
      },
      now,
    };
    await generateItineraryDetailed(deps, CONTEXT, { grounding: BUNDLE });
    await generateItineraryDetailed(deps, CONTEXT);
    expect(seen[0].system).toContain("Alfama walking guide");
    expect(seen[0].user).not.toContain("Alfama");
    expect(seen[1].system).not.toContain("Alfama");
  });
});
