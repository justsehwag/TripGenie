import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  VERIFIED_TEXT,
  TRUST_SENTENCE,
  LEGACY_NOTE,
  LIMIT_NOTE,
  TOTAL_NOTE,
  failureTitle,
  verifiedLinkLabel,
  withheldText,
  retryLabel,
  failureReason,
  progressText,
  verifiedLabel,
  activitiesLabel,
  travelLabel,
} from "@/lib/itinerary/labels";
import { sanitizeDisplayText } from "@/lib/itinerary/text";
import { priceLabel } from "@/lib/itinerary-inr";

// Feature: trustworthy-itinerary, Property 25: Trust wording
// **Validates: Requirements 1.1, 1.4, 6.10, 8.5, 9.7**

const NUM_RUNS = 100;

/** Claim words; "not guaranteed" denies a guarantee and is allowed. */
function claims(s: string): string[] {
  const out: string[] = [];
  const t = s.toLowerCase();
  if (/(?<!not )guarantee/.test(t)) out.push("guarantee");
  if (/confirmed/.test(t)) out.push("confirmed");
  if (/bookable/.test(t)) out.push("bookable");
  if (/100\s*%\s*accurate/.test(t)) out.push("100% accurate");
  return out;
}

const day = fc.integer({ min: -5, max: 400 });
const dayOdd = fc.oneof(day, fc.constantFrom(NaN, Infinity, -Infinity, 1.7));
const place = fc.oneof(
  fc.string({ maxLength: 300 }),
  fc.fullUnicodeString({ maxLength: 100 }),
  fc.constantFrom(
    "<script>alert(1)</script>",
    "\u202Eevil\u0000\n\t",
    "   ",
    "",
    "Café \"Zoë\" & <b>Sons</b>",
    "x".repeat(500),
  ),
);
const reason = fc.oneof(
  fc.constantFrom("not-configured", "unverified", "unavailable", undefined, null, ""),
  fc.string({ maxLength: 60 }),
);
const kind = fc.constantFrom("verifying", "added", "withheld" as const) as fc.Arbitrary<
  "verifying" | "added" | "withheld"
>;

describe("Property 25: Trust wording", () => {
  it("constant strings make no trust claims and the indicator text is exact", () => {
    expect(VERIFIED_TEXT).toBe("Verified on Google Maps");
    for (const s of [TRUST_SENTENCE, LEGACY_NOTE, LIMIT_NOTE, TOTAL_NOTE, failureTitle, VERIFIED_TEXT]) {
      expect(claims(s)).toEqual([]);
    }
    expect(TRUST_SENTENCE).toMatch(/can change, so check before you go/);
  });

  it("verifiedLinkLabel has the required form and no claims", () => {
    fc.assert(
      fc.property(place, (p) => {
        const label = verifiedLinkLabel(p);
        const name = sanitizeDisplayText(p, 120);
        expect(label).toBe(
          name
            ? `Verified on Google Maps: ${name}, opens in a new tab`
            : "Verified on Google Maps, opens in a new tab",
        );
        // Place names are data, not wording: exclude them from the claim scan.
        const wording = name ? label.replace(name, "") : label;
        expect(claims(wording)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("retry, withheld and progress texts name the days and make no claims", () => {
    fc.assert(
      fc.property(dayOdd, dayOdd, kind, (a, b, k) => {
        const norm = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
        const from = norm(a);
        const to = norm(b);
        const retry = retryLabel(a, b);
        expect(retry).toBe(to > from ? `Retry days ${from} to ${to}` : `Retry day ${from}`);
        expect(retry).toMatch(/^Retry days? \d+( to \d+)?$/);
        const withheld = withheldText(a, b);
        expect(withheld).toMatch(/^Days? \d+( to \d+)? could not be verified$/);
        const progress = progressText(k, a, b);
        expect(progress).toMatch(new RegExp(`\\b(day|days) ${from}\\b`, "i"));
        for (const s of [retry, withheld, progress]) expect(claims(s)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("failure reasons make no claims for any reason", () => {
    fc.assert(
      fc.property(reason, (r) => {
        const text = failureReason(r as string | null | undefined);
        expect(text.length).toBeGreaterThan(0);
        expect(claims(text)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("completeness labels and travel label make no claims; travel is an estimate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 14 }),
        fc.integer({ min: 0, max: 30 }),
        fc.oneof(fc.double({ noDefaultInfinity: false }), fc.integer({ min: -10, max: 5000 })),
        (v, n, minutes) => {
          const c = {
            requestedDays: n,
            verifiedDays: Array.from({ length: v }, (_, i) => i + 1),
          } as unknown as Parameters<typeof verifiedLabel>[0];
          expect(claims(verifiedLabel(c))).toEqual([]);
          expect(claims(activitiesLabel(c))).toEqual([]);
          expect(claims(activitiesLabel(undefined))).toEqual([]);
          const t = travelLabel(minutes);
          expect(t).toContain("estimate");
          expect(claims(t)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("price labels never say confirmed or bookable", () => {
    for (const s of ["web", "ai", undefined, "estimated"] as const) {
      const label = priceLabel(s as never);
      expect(claims(label)).toEqual([]);
    }
  });
});
