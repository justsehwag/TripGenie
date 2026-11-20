import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  BANNED_PHRASES,
  NEUTRAL_REPLY,
  NEUTRAL_SUMMARY,
  containsBannedPhrase,
  screenReply,
  screenSummary,
} from "./honesty";

const RUNS = { numRuns: 150 };

const noBannedInAnyCase = (s: string): boolean => {
  const lower = s.toLowerCase();
  return !BANNED_PHRASES.some((p) => lower.includes(p)) && !containsBannedPhrase(s);
};

const randomCase = (phrase: string, flips: boolean[]): string =>
  phrase
    .split("")
    .map((c, i) => (flips[i % flips.length] ? c.toUpperCase() : c.toLowerCase()))
    .join("");

const bannedArb = fc
  .tuple(
    fc.constantFrom(...BANNED_PHRASES),
    fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
    fc.string({ maxLength: 40 }),
    fc.string({ maxLength: 40 }),
  )
  .map(([phrase, flips, before, after]) => before + randomCase(phrase, flips) + after);

const cleanArb = fc.string({ maxLength: 120 }).filter((s) => !containsBannedPhrase(s));

describe("honesty screen", () => {
  // Feature: trip-assistant-chat, Property 10: The honesty screen removes banned phrases
  it("replaces any text containing a banned phrase in any letter case (Requirements 12.1, 12.2)", () => {
    fc.assert(
      fc.property(bannedArb, (text) => {
        const out = screenReply(text);
        expect(out.replaced).toBe(true);
        expect(out.text).toBe(NEUTRAL_REPLY);
        expect(noBannedInAnyCase(out.text)).toBe(true);
      }),
      RUNS,
    );
  });

  // Feature: trip-assistant-chat, Property 10: The honesty screen removes banned phrases
  it("leaves text without a banned phrase unchanged (Requirements 12.1, 12.2)", () => {
    fc.assert(
      fc.property(cleanArb, (text) => {
        const out = screenReply(text);
        expect(out.replaced).toBe(false);
        expect(out.text).toBe(text);
      }),
      RUNS,
    );
  });

  // Feature: trip-assistant-chat, Property 10: The honesty screen removes banned phrases
  it("screenSummary returns the fallback on a match and the text otherwise (Requirements 12.2)", () => {
    fc.assert(
      fc.property(bannedArb, (text) => {
        const out = screenSummary(text, "Replace stop 2 on day 3");
        expect(out.replaced).toBe(true);
        expect(out.text).toBe("Replace stop 2 on day 3");
        expect(noBannedInAnyCase(out.text)).toBe(true);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(cleanArb, (text) => {
        const out = screenSummary(text, "Replace stop 2 on day 3");
        expect(out).toEqual({ text, replaced: false });
      }),
      RUNS,
    );
  });

  it("screenSummary uses the neutral summary when the fallback is itself banned or blank", () => {
    expect(screenSummary("Guaranteed fix", "Confirmed swap")).toEqual({ text: NEUTRAL_SUMMARY, replaced: true });
    expect(screenSummary("Bookable hotel", "   ")).toEqual({ text: NEUTRAL_SUMMARY, replaced: true });
  });

  it("catches each banned phrase and the spaced 100 % accurate form", () => {
    for (const p of BANNED_PHRASES) expect(screenReply(`It is ${p.toUpperCase()}.`).replaced).toBe(true);
    expect(screenReply("Totally 100 % accurate").replaced).toBe(true);
  });
});
