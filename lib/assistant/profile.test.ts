import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildProfileText, toProfileSubset } from "./snapshot";
import { parseRequest, whitelistProfile } from "./wire";
import { buildSystemPrompt } from "./prompt";
import type { WireItinerary } from "./types";

const ALLOWED = ["firstName", "homeCity", "travelStyle", "party"];

const DISALLOWED_KEYS = [
  "userId",
  "id",
  "email",
  "phone",
  "cardNumber",
  "cvv",
  "paymentMethod",
  "payment",
  "bookingId",
  "bookingIds",
  "address",
  "passport",
  "nested",
];

const word = fc.stringMatching(/^[A-Za-z]{1,12}$/);
const phrase = fc
  .array(word, { minLength: 1, maxLength: 3 })
  .map((w) => w.join(" "));

const allowedFields = fc.record(
  {
    firstName: phrase,
    homeCity: phrase,
    travelStyle: phrase,
    party: fc.record({ adults: fc.integer({ min: 0, max: 50 }), children: fc.integer({ min: 0, max: 50 }) }),
  },
  { requiredKeys: [] },
);

/** Builds an input with allowed fields plus disallowed keys holding unique sentinels. */
const profileInput = fc
  .tuple(allowedFields, fc.uuid(), fc.subarray(DISALLOWED_KEYS, { minLength: 1 }))
  .map(([allowed, uid, keys]) => {
    const sentinels: string[] = [];
    const extra: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      const s = `SENTINEL${i}${uid.replace(/-/g, "")}`;
      sentinels.push(s);
      if (k === "nested" || k === "payment" || k === "bookingIds") {
        extra[k] = { deep: { value: s }, list: [s] };
      } else {
        extra[k] = s;
      }
    });
    return { input: { ...extra, ...allowed } as Record<string, unknown>, sentinels };
  });

const itinerary: WireItinerary = {
  title: "Trip",
  totalCost: 0,
  days: [{ day: 1, date: "2025-01-01", title: "Day one", theme: "Walk", total: 0, activities: [] }],
};

function sortedKeys(o: unknown): string[] {
  return o && typeof o === "object" ? Object.keys(o as object).sort() : [];
}

// Feature: trip-assistant-chat, Property 15: The profile projection exposes only allowed fields
describe("Property 15: profile projection exposes only allowed fields", () => {
  it("toProfileSubset and whitelistProfile keep only allowed keys and agree", () => {
    fc.assert(
      fc.property(profileInput, ({ input }) => {
        const a = toProfileSubset(input);
        const b = whitelistProfile(input);
        for (const r of [a, b]) {
          for (const k of sortedKeys(r)) expect(ALLOWED).toContain(k);
        }
        expect(a).toEqual(b);
        expect(a).toEqual(
          Object.keys(input).some((k) => ALLOWED.includes(k)) ? expect.anything() : undefined,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("profile text and system prompt never contain disallowed values", () => {
    fc.assert(
      fc.property(profileInput, ({ input, sentinels }) => {
        const subset = toProfileSubset(input);
        const text = buildProfileText(subset);
        // buildProfileText re-whitelists, so passing the raw input is also safe.
        const rawText = buildProfileText(input as never);
        const prompt = buildSystemPrompt({ profile: subset, itinerary });
        const rawPrompt = buildSystemPrompt({ profile: input as never, itinerary });
        for (const s of sentinels) {
          expect(text).not.toContain(s);
          expect(rawText).not.toContain(s);
          expect(prompt).not.toContain(s);
          expect(rawPrompt).not.toContain(s);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("parseRequest strips disallowed profile fields", () => {
    fc.assert(
      fc.property(profileInput, ({ input, sentinels }) => {
        const r = parseRequest({ message: "hello", itinerary, profile: input });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        for (const k of sortedKeys(r.value.profile)) expect(ALLOWED).toContain(k);
        expect(r.value.profile).toEqual(whitelistProfile(input));
        const json = JSON.stringify(r.value);
        for (const s of sentinels) expect(json).not.toContain(s);
      }),
      { numRuns: 100 },
    );
  });
});
