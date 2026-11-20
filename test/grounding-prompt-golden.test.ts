/**
 * Golden snapshot of buildItineraryPrompt(context). Originally captured BEFORE
 * the searxng-itinerary-grounding changes to lib/bedrock-model.ts. The GOLDEN
 * constant was regenerated on purpose by the trustworthy-itinerary spec (task
 * 2.8), when buildItineraryPrompt became a wrapper over buildBatchPrompt. It is
 * the only intentional golden update; it still guards that the prompt stays
 * byte-identical when no grounding is supplied.
 */
import { describe, expect, it } from "vitest";
import { buildItineraryPrompt } from "../lib/bedrock-model";
import { GEN_TIMEOUT_MS } from "../lib/itinerary/constants";
import { maxTokensFor } from "../lib/itinerary/pace";
import { SYSTEM_PROMPT_PREFIX } from "../lib/system-prompt";
import type { TripContext } from "../lib/types";

const CONTEXT = {
  destination: "Lisbon",
  durationDays: 3,
  budgetLevel: "mid",
  interests: ["food", "history"],
} as unknown as TripContext;

const GOLDEN = {"system":"You are Tripsaathi AI, a bounded travel-planning concierge. Extract only structured trip context from the latest input delta. Ask one question at a time, never fabricate availability, and keep answers under 160 characters.\n\nYou are an expert local travel planner. Plan days 1 to 3 of a 3-day trip to Lisbon using the full trip context.\n\nHard rules:\n- Name REAL, specific places in Lisbon: each \"place\" is the exact name a traveller finds on Google Maps (a landmark, museum, temple, beach, viewpoint, park, market, or a named restaurant or cafe). Never write vague placeholders like \"local lunch\", \"signature experience\", \"afternoon activity\", \"evening experience\", \"free time\" or \"explore the city\".\n- Stop target: 4 stops per full day, never fewer than 3 or more than 5. Day 1 is the arrival day: at most 2 stops, none before the traveller arrives. Day 3 is the departure day: at most 2 stops, finishing early enough for the journey home.\n- Group each day's stops in one area, name that area in the day title, and order the stops in a sensible visiting sequence. Do not zig-zag across the destination.\n- Meals name a specific restaurant, cafe, market or food street close to the neighbouring stops. A district or a cuisine alone is not a place.\n- No place may appear twice in the whole trip. Never use a place listed under PLACES ALREADY USED below.\n- Do not plan a day trip outside the usual area.\n- Respect the traveller's duration, party, budget level, diet, pace and interests.\n- Every cost is an INR ESTIMATE per person. Never mark any flight, stay, or car as confirmed or available.\n- Keep each activity description to one concrete sentence that references the real place.\n\nReturn ONLY a single JSON object (no prose, no code fences) in EXACTLY this shape:\n{\n  \"days\": [\n    {\n      \"title\": string,\n      \"dayTrip\": boolean,\n      \"activities\": [ { \"time\": \"09:00\", \"place\": string, \"area\": string, \"kind\": \"sight\" | \"meal\" | \"experience\", \"description\": string, \"cost\": number } ]\n    }\n  ]\n}\nReturn exactly 3 days in order. Do not number the days. Each cost is an INR estimate per person.","user":"Trip context: {\"destination\":\"Lisbon\",\"durationDays\":3,\"budgetLevel\":\"mid\",\"interests\":[\"food\",\"history\"]}\nPlan days 1 to 3.","maxTokens":1570,"timeoutMs":11600};

describe("buildItineraryPrompt golden (pre-grounding)", () => {
  it("matches the stored prompt exactly", () => {
    const out = buildItineraryPrompt(CONTEXT);
    expect(out.system).toBe(GOLDEN.system);
    expect(out.user).toBe(GOLDEN.user);
    expect(out.maxTokens).toBe(GOLDEN.maxTokens);
    expect(out).toEqual(GOLDEN);
  });

  it("holds the byte-independent prompt invariants", () => {
    const out = buildItineraryPrompt(CONTEXT);
    expect(out.system.startsWith(SYSTEM_PROMPT_PREFIX)).toBe(true);
    expect(out.system).not.toContain("EXACTLY 5");
    expect(out.system).toContain("Stop target: 4 stops per full day, never fewer than 3 or more than 5");
    expect(out.system).toContain("No place may appear twice in the whole trip");
    expect(out.maxTokens).toBe(maxTokensFor(3, "balanced"));
    expect(out.timeoutMs).toBe(GEN_TIMEOUT_MS);
  });
});
