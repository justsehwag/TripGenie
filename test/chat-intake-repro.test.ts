/**
 * Reproduction of the chat-intake bug (spec chat-images-bedrock-planner, task 1.1),
 * re-pointed to the fixed code in task 2.7. Fixed by 2.1 (extraction-grounding,
 * validateDiet), 2.2 (diet validation in both fallback extractors) and 2.3
 * (lib/chat-intake.ts `step`).
 *
 * Observed failure on the UNFIXED code (recorded from the first run):
 *  - Scenario A (seeded full context + "From Mumbai to Singapore"): `advance`
 *    returned phase "completion" with COMPLETION_TEXT on turn 1, and
 *    `uncollected(ctx)` was empty, which made `redirectIfComplete` call
 *    `router.push("/trip")` after 900 ms. The six carried fields (durationDays,
 *    travellers, budgetLevel, diet, pace, interests) were merged silently by
 *    `{ ...state.context, ...extracted }` (preference-controller.ts:110) and never
 *    asked or confirmed.
 *  - Scenario B (asked field `diet`, text "From Delhi to Goa"): both
 *    `fallbackExtractForField` implementations (lib/intake-fallback.ts:88 and
 *    lib/bedrock-model.ts:702-705) set diet to the route text "From Delhi to Goa".
 *
 * Fixed behaviour asserted here:
 *  - Seeding marks carried fields "carried" and shows a recap; nothing navigates.
 *  - A route-only turn never navigates (only the `generate` event does) and the
 *    chat ends in the summary phase for the traveller to review, not completion.
 *  - Route-only grounding keeps only origin and destination.
 *  - The diet extractors leave diet unset for a route phrase.
 *
 * No network: only the offline fallback extractor is used.
 */
import { describe, expect, it } from "vitest";
import { step, summaryRows, type ChatIntakeState, type ChatStep } from "../lib/chat-intake";
import { groundExtraction } from "../lib/extraction-grounding";
import { COMPLETION_TEXT } from "../lib/preference-controller";
import { fallbackExtractForField as clientFallback } from "../lib/intake-fallback";
import { fallbackExtractForField as serverFallback } from "../lib/bedrock-model";
import type { TripContext } from "../lib/types";

/** Mirrors the persisted Shared_Trip_Context a previous trip leaves in sessionStorage. */
const SEEDED: TripContext = {
  durationDays: 4,
  travellers: { adults: 2, children: 0 },
  budgetLevel: "mid",
  diet: "vegetarian",
  pace: "balanced",
  interests: ["food", "culture"],
};

const CARRIED = ["durationDays", "travellers", "budgetLevel", "diet", "pace", "interests"] as const;

/** Same wiring as concierge-home: seed event, then a text turn with grounded extraction. */
function routeChipTurn(text: string): { seeded: ChatStep; turn: ChatStep } {
  const seeded = step({} as ChatIntakeState, { type: "seed", context: { ...SEEDED } });
  const asked = seeded.state.asked ?? undefined;
  const raw = clientFallback(text, {}, asked);
  const grounded = groundExtraction({ text, asked, extracted: raw });
  const turn = step(seeded.state, { type: "text", text, extracted: grounded.fields });
  return { seeded, turn };
}

describe("chat intake reproduction (fixed code)", () => {
  it("A1: a route-only chip with a seeded full context does not complete the chat", () => {
    const { seeded, turn } = routeChipTurn("From Mumbai to Singapore");
    expect(seeded.message).not.toBe(COMPLETION_TEXT);
    expect(turn.message).not.toBe(COMPLETION_TEXT);
    // Seeding recaps the carried values instead of completing.
    expect(seeded.state.phase).toBe("recap");
    expect(seeded.message).toContain("earlier trip");
    // After the route turn the traveller reaches the summary, never a completion phase.
    expect(turn.state.phase).toBe("summary");
  });

  it("A2: a route-only chip with a seeded full context does not navigate to /trip", () => {
    const { seeded, turn } = routeChipTurn("From Mumbai to Singapore");
    expect(seeded.navigate).toBe(false);
    expect(turn.navigate).toBe(false);
    // Navigation happens only on an explicit generate event.
    expect(step(turn.state, { type: "generate" }).navigate).toBe(true);
  });

  it("A3: carried fields are not silently counted as answered by the route turn", () => {
    const { seeded, turn } = routeChipTurn("From Mumbai to Singapore");
    // Right after seeding, every carried field is flagged "carried", not "answered".
    for (const f of CARRIED) expect(seeded.state.status[f]).toBe("carried");
    // The grounded route-only turn supplies only origin and destination.
    const text = "From Mumbai to Singapore";
    const grounded = groundExtraction({ text, asked: undefined, extracted: clientFallback(text, {}, undefined) });
    expect(grounded.routeOnly).toBe(true);
    expect(Object.keys(grounded.fields).filter((k) => !["origin", "destination"].includes(k))).toEqual([]);
    // The summary still shows each carried value with its "from your earlier trip" flag.
    const rows = summaryRows(seeded.state);
    for (const f of CARRIED) expect(rows.find((r) => r.field === f)?.carried).toBe(true);
    expect(turn.state.context.origin).toBeDefined();
    expect(turn.state.context.destination).toBeDefined();
  });

  it("B: asked field diet with the text 'From Delhi to Goa' leaves diet unset (client fallback)", () => {
    const out = clientFallback("From Delhi to Goa", {}, "diet");
    expect(out.diet).toBeUndefined();
  });

  it("B: asked field diet with the text 'From Delhi to Goa' leaves diet unset (bedrock-model fallback)", () => {
    const out = serverFallback("From Delhi to Goa", {}, "diet");
    expect(out.diet).toBeUndefined();
  });
});
