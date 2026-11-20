import { describe, expect, it } from "vitest";
import { buildBatchPrompt } from "@/lib/itinerary/prompt";
import { buildItineraryPrompt } from "@/lib/bedrock-model";
import { dayLimits } from "@/lib/itinerary/pace";
import type { TripContext } from "@/lib/types";

const context = { destination: "Goa", durationDays: 4, pace: "balanced" } as unknown as TripContext;
const input = {
  context,
  fromDay: 1,
  dayCount: 3,
  totalDays: 4,
  usedPlaces: [] as string[],
  dayTripsAllowed: 0,
};

const SPARE = "Add one spare stop per day beyond that day's maximum, listed last.";

describe("batch prompt spare stop rule", () => {
  it("adds the spare line right after the Stop target line", () => {
    const sys = buildBatchPrompt(input).system;
    const lines = sys.split("\n");
    const at = lines.findIndex((l) => l.startsWith("- Stop target:"));
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toContain(SPARE);
    expect(lines[at + 1]).toContain("cannot be verified on Google Maps");
  });

  it("keeps the existing rule lines unchanged", () => {
    const sys = buildBatchPrompt(input).system;
    const full = dayLimits("balanced", 1, 1);
    expect(sys).toContain(
      `- Stop target: ${full.target} stops per full day, never fewer than ${full.min} or more than ${full.max}.`,
    );
    expect(sys).toContain("- No place may appear twice in the whole trip. Never use a place listed under PLACES ALREADY USED below.");
    expect(sys).toContain("- Respect the traveller's duration, party, budget level, diet, pace and interests.");
    expect(sys).toContain("- Keep each activity description to one concrete sentence that references the real place.");
    expect(sys).toContain("Return exactly 3 days in order.");
  });

  it("leaves the legacy single-call prompt without the spare line", () => {
    expect(buildItineraryPrompt(context).system).not.toContain("spare stop");
    expect(buildBatchPrompt({ ...input, spareStop: false }).system).not.toContain("spare stop");
  });
});
