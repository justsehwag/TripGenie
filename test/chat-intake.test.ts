import { describe, expect, it } from "vitest";
import {
  SKIPPABLE,
  SKIP_REFUSAL_TEXT,
  initialIntakeState,
  nextUnset,
  step,
  summaryRows,
  type ChatIntakeState,
  type ChatEvent,
} from "@/lib/chat-intake";
import { fallbackPhrase } from "@/lib/intake-fallback";
import { REQUIRED_FIELDS, MAX_QUESTIONS } from "@/lib/preference-controller";

function run(events: ChatEvent[], from: ChatIntakeState = initialIntakeState()) {
  let state = from;
  let last = { state, message: "", navigate: false };
  for (const e of events) {
    last = step(state, e);
    state = last.state;
  }
  return last;
}

const FULL = {
  origin: "Delhi",
  destination: "Goa",
  durationDays: 4,
  travellers: { adults: 2, children: 0 },
  budgetLevel: "mid",
  diet: "vegetarian",
  pace: "relaxed",
  interests: ["beaches"],
};

describe("chat-intake", () => {
  it("starts by asking origin with nothing set", () => {
    const s = initialIntakeState();
    expect(s.asked).toBe("origin");
    expect(s.context).toEqual({});
    expect(nextUnset(s)).toBe("origin");
  });

  it("asks fields in the fixed order, one per turn", () => {
    let state = initialIntakeState();
    const answers: Record<string, unknown> = {
      origin: "Delhi",
      destination: "Goa",
      durationDays: 3,
      travellers: { adults: 2, children: 0 },
      budgetLevel: "mid",
      diet: "veg",
      pace: "packed",
      interests: ["food"],
    };
    for (let i = 0; i < REQUIRED_FIELDS.length; i++) {
      const f = REQUIRED_FIELDS[i];
      expect(state.asked).toBe(f);
      const r = step(state, { type: "text", text: "x", extracted: { [f]: answers[f] } });
      state = r.state;
      if (i < REQUIRED_FIELDS.length - 1) expect(r.message).toBe(fallbackPhrase(REQUIRED_FIELDS[i + 1]));
    }
    expect(state.phase).toBe("summary");
    expect(state.asked).toBeNull();
  });

  it("re-asks without counting when nothing was extracted", () => {
    const s0 = initialIntakeState();
    const r = step(s0, { type: "text", text: "hello", extracted: {} });
    expect(r.state.asked).toBe("origin");
    expect(r.state.questionsAsked).toBe(s0.questionsAsked);
    expect(r.state.context).toEqual({});
    expect(r.message).toContain(fallbackPhrase("origin"));
  });

  it("route-only turn on diet leaves diet unset and re-asks diet", () => {
    const r = run([
      { type: "seed", context: {} },
      { type: "text", text: "a", extracted: { origin: "Delhi" } },
      { type: "text", text: "a", extracted: { destination: "Goa" } },
      { type: "text", text: "a", extracted: { durationDays: 3 } },
      { type: "text", text: "a", extracted: { travellers: { adults: 1, children: 0 } } },
      { type: "text", text: "a", extracted: { budgetLevel: "mid" } },
      { type: "text", text: "From Delhi to Goa", extracted: {} },
    ]);
    expect(r.state.asked).toBe("diet");
    expect(r.state.context.diet).toBeUndefined();
    expect(r.state.status.diet).toBe("unset");
  });

  it("skip records skipped, leaves value unset, asks the next question", () => {
    const base = run([
      { type: "text", text: "a", extracted: { origin: "Delhi", destination: "Goa" } },
    ]);
    expect(base.state.asked).toBe("durationDays");
    const r = step(base.state, { type: "skip" });
    expect(r.state.status.durationDays).toBe("skipped");
    expect(r.state.context.durationDays).toBeUndefined();
    expect(r.state.asked).toBe("travellers");
  });

  it("refuses to skip origin and destination", () => {
    expect(SKIPPABLE).not.toContain("origin");
    expect(SKIPPABLE).not.toContain("destination");
    const r = step(initialIntakeState(), { type: "skip" });
    expect(r.state.status.origin).toBe("unset");
    expect(r.state.asked).toBe("origin");
    expect(r.message).toContain(SKIP_REFUSAL_TEXT);
  });

  it("seed marks values carried, recaps them and asks only unset fields", () => {
    const r = step(initialIntakeState(), {
      type: "seed",
      context: { origin: "Delhi", destination: "Goa", pace: "packed" },
    });
    expect(r.state.phase).toBe("recap");
    expect(r.state.status.origin).toBe("carried");
    expect(r.state.status.pace).toBe("carried");
    expect(r.state.asked).toBe("durationDays");
    expect(r.message).toContain("Already provided");
    expect(r.message).toContain("Delhi");
    expect(r.navigate).toBe(false);
  });

  it("a route turn on a fully carried context does not complete or navigate", () => {
    const seeded = step(initialIntakeState(), { type: "seed", context: FULL });
    expect(seeded.state.phase).toBe("recap");
    expect(seeded.navigate).toBe(false);
    const r = step(seeded.state, {
      type: "text",
      text: "From Mumbai to Singapore",
      extracted: { origin: "Mumbai", destination: "Singapore" },
    });
    expect(r.navigate).toBe(false);
    expect(r.state.context.origin).toBe("Mumbai");
    expect(r.state.context.destination).toBe("Singapore");
    expect(r.state.context.diet).toBe("vegetarian");
    expect(r.state.phase).toBe("summary");
  });

  it("does not overwrite an answered field that is not the asked one", () => {
    const r = run([
      { type: "text", text: "a", extracted: { origin: "Delhi" } },
      { type: "text", text: "b", extracted: { origin: "Pune", destination: "Goa" } },
    ]);
    expect(r.state.context.origin).toBe("Delhi");
    expect(r.state.context.destination).toBe("Goa");
  });

  it("navigates only on generate with origin and destination set", () => {
    const filled = run([
      { type: "text", text: "a", extracted: { origin: "Delhi", destination: "Goa" } },
    ]);
    expect(filled.navigate).toBe(false);
    expect(step(filled.state, { type: "generate" }).navigate).toBe(true);

    const empty = step(initialIntakeState(), { type: "generate" });
    expect(empty.navigate).toBe(false);
    expect(empty.state.asked).toBe("origin");
    expect(empty.message).toBe(fallbackPhrase("origin"));
  });

  it("summary rows use fixed order, never fill defaults, and note defaults as text", () => {
    const r = run([
      { type: "text", text: "a", extracted: { origin: "Delhi", destination: "Goa" } },
      { type: "skip" },
      { type: "skip" },
      { type: "skip" },
      { type: "skip" },
      { type: "skip" },
    ]);
    const rows = summaryRows(r.state);
    expect(rows.map((x) => x.field)).toEqual([...REQUIRED_FIELDS]);
    expect(rows.find((x) => x.field === "pace")).toMatchObject({ display: "Skipped", defaultNote: "Pace defaults to balanced" });
    expect(rows.find((x) => x.field === "interests")?.display).toBe("Not answered");
    expect(r.state.context.pace).toBeUndefined();
    expect(r.state.asked).toBe("interests");
    const done = step(r.state, { type: "skip" });
    expect(done.state.phase).toBe("summary");
    expect(done.state.asked).toBeNull();
    expect(done.navigate).toBe(false);
    expect(summaryRows(done.state).find((x) => x.field === "interests")?.display).toBe("Skipped");
  });

  it("carried rows are tagged", () => {
    const r = step(initialIntakeState(), { type: "seed", context: FULL });
    expect(summaryRows(r.state).every((x) => x.carried)).toBe(true);
  });

  it("edit replaces only that field; clearing a field makes it unset and asks it", () => {
    const seeded = step(initialIntakeState(), { type: "seed", context: FULL }).state;
    const edited = step(seeded, { type: "edit", field: "pace", value: "packed" });
    expect(edited.state.context).toEqual({ ...FULL, pace: "packed" });
    expect(edited.state.status.pace).toBe("answered");
    expect(edited.state.status.diet).toBe("carried");
    const cleared = step(edited.state, { type: "edit", field: "diet", value: undefined });
    expect(cleared.state.context.diet).toBeUndefined();
    expect(cleared.state.asked).toBe("diet");
  });

  it("goes to summary at MAX_QUESTIONS with fields Not answered", () => {
    // Each turn answers a different, later field out of order so questions run out early.
    let state = initialIntakeState();
    state = { ...state, questionsAsked: MAX_QUESTIONS };
    const r = step(state, { type: "text", text: "a", extracted: { origin: "Delhi" } });
    expect(r.state.phase).toBe("summary");
    expect(summaryRows(r.state).find((x) => x.field === "destination")?.display).toBe("Not answered");
    expect(r.state.context.destination).toBeUndefined();
    expect(step(r.state, { type: "generate" }).navigate).toBe(false);
  });

  it("reset clears everything", () => {
    const filled = step(initialIntakeState(), { type: "seed", context: FULL }).state;
    const r = step(filled, { type: "reset" });
    expect(r.state).toEqual(initialIntakeState());
    expect(r.navigate).toBe(false);
  });
});
