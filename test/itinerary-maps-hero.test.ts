import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  buildMapsUrl,
  isSafeMapsUrl,
  isValidPhotoRef,
} from "../lib/itinerary/maps-link";
import { pickDayHeroes } from "../lib/itinerary/hero";
import type { TripDay } from "../lib/types";

const NUM_RUNS = 100;

// ---- Arbitraries (test inputs only) ----

const HOSTILE_FRAGMENTS = [
  "&",
  "#",
  "?",
  "%",
  "%26",
  "\"",
  "'",
  " ",
  "javascript:alert(1)",
  "&query_place_id=evil",
  "#frag",
  "../",
  "é",
  "日本",
];

const nonSurrogateCodePoint = fc
  .integer({ min: 0xa0, max: 0x10ffff })
  .filter((c) => c < 0xd800 || c > 0xdfff)
  .map((c) => String.fromCodePoint(c));

const hostileText = fc
  .array(
    fc.oneof(
      fc.constantFrom(...HOSTILE_FRAGMENTS),
      fc.string({ maxLength: 8 }),
      nonSurrogateCodePoint,
    ),
    { maxLength: 8 },
  )
  .map((parts) => parts.join(""));

const idPart = fc.stringMatching(/^[A-Za-z0-9_-]{1,20}$/);

const photoRefArb = fc
  .tuple(idPart, idPart)
  .map(([p, h]) => `places/${p}/photos/${h}`);

// ---- Property 20 ----

describe("itinerary maps link", () => {
  // Feature: trustworthy-itinerary, Property 20: Maps link safety
  it("Property 20: buildMapsUrl output is a safe, structurally intact https Maps URL", () => {
    fc.assert(
      fc.property(hostileText, hostileText, (placeId, name) => {
        const url = buildMapsUrl(placeId, name);
        expect(isSafeMapsUrl(url)).toBe(true);

        const u = new URL(url);
        expect(u.protocol).toBe("https:");
        expect(u.hostname).toBe("www.google.com");
        expect(u.pathname.startsWith("/maps")).toBe(true);
        expect(u.username).toBe("");
        expect(u.password).toBe("");

        // No raw '#' from inputs: no fragment at all.
        expect(url.includes("#")).toBe(false);
        expect(u.hash).toBe("");

        // Exactly three query params; input '&' cannot add or split any.
        expect(url.split("&").length).toBe(3);
        expect([...u.searchParams.keys()]).toEqual([
          "api",
          "query",
          "query_place_id",
        ]);
        // Values round-trip, so the encoded placeId/name are present intact.
        expect(u.searchParams.get("query")).toBe(name);
        expect(u.searchParams.get("query_place_id")).toBe(placeId);
        expect(url).toContain(`query_place_id=${encodeURIComponent(placeId)}`);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 20: Maps link safety
  it("Property 20: buildMapsUrl never throws, even for lone surrogates", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", maxLength: 12 }),
        fc.string({ unit: "binary", maxLength: 12 }),
        (a, b) => {
          const url = buildMapsUrl(a, b);
          expect(isSafeMapsUrl(url)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 20: Maps link safety
  it("Property 20: isSafeMapsUrl rejects hostile URLs and non-strings", () => {
    const suffix = fc.constantFrom("", "/", "/search/?api=1&query=x", "/place/x");
    const rejected = fc.oneof(
      suffix.map((s) => `http://www.google.com/maps${s}`),
      suffix.map((s) => `https://evil.com/maps${s}`),
      suffix.map((s) => `https://www.google.com.evil.com/maps${s}`),
      suffix.map((s) => `https://evil.com/?u=https://www.google.com/maps${s}`),
      suffix.map((s) => `https://user:pw@www.google.com/maps${s}`),
      suffix.map((s) => `https://www.google.com@evil.com/maps${s}`),
      suffix.map((s) => `https://www.google.com:8443/maps${s}`),
      suffix.map((s) => `https://www.google.com/search${s}`),
      suffix.map((s) => `//www.google.com/maps${s}`),
      suffix.map((s) => `/maps${s}`),
      suffix.map((s) => `javascript:alert(1)//https://www.google.com/maps${s}`),
      suffix.map((s) => `javascript:https://www.google.com/maps${s}`),
      suffix.map((s) => `data:text/html,https://www.google.com/maps${s}`),
      suffix.map((s) => ` https://www.google.com/maps${s}`),
      hostileText,
    );
    fc.assert(
      fc.property(rejected, (url) => {
        expect(isSafeMapsUrl(url)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );

    fc.assert(
      fc.property(
        fc.anything().filter((v) => typeof v !== "string"),
        (v) => {
          expect(isSafeMapsUrl(v)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 20: Maps link safety
  it("Property 20: isValidPhotoRef accepts exactly places/<id>/photos/<id>", () => {
    fc.assert(
      fc.property(photoRefArb, (ref) => {
        expect(isValidPhotoRef(ref)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );

    const invalid = fc.oneof(
      photoRefArb.map((r) => `${r}/extra`),
      photoRefArb.map((r) => `/${r}`),
      photoRefArb.map((r) => `${r}/`),
      photoRefArb.map((r) => `x${r}`),
      photoRefArb.map((r) => r.replace("places/", "place/")),
      photoRefArb.map((r) => r.replace("/photos/", "/photo/")),
      photoRefArb.map((r) => r.replace(/places\/[^/]+/, "places/")),
      photoRefArb.map((r) => r.replace(/photos\/[^/]+$/, "photos/")),
      photoRefArb.map((r) => `${r}\n`),
      photoRefArb.map((r) => `https://example.com/${r}`),
      idPart.map((id) => `places/${id}`),
      idPart.map((id) => `photos/${id}`),
      fc.constantFrom("", "places//photos/", "javascript:alert(1)"),
    );
    fc.assert(
      fc.property(invalid, (ref) => {
        expect(isValidPhotoRef(ref)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );

    fc.assert(
      fc.property(
        fc.anything().filter((v) => typeof v !== "string"),
        (v) => {
          expect(isValidPhotoRef(v)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---- Property 21 ----

// Small pool so duplicates across days are frequent.
const refPool = ["a", "b", "c", "d", "e"].map((i) => `places/P${i}/photos/H${i}`);

const activityArb = fc.record({
  photoRef: fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...refPool) },
    { weight: 1, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: fc.constantFrom("", "not-a-ref", "places/x") },
  ),
  placeName: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
  title: fc.string({ maxLength: 10 }),
});

const daysArb = fc
  .array(fc.array(activityArb, { maxLength: 5 }), { maxLength: 7 })
  .map(
    (list) =>
      list.map((activities, i) => ({
        day: i + 1,
        date: "2025-01-01",
        activities,
      })) as unknown as TripDay[],
  );

describe("itinerary day heroes", () => {
  // Feature: trustworthy-itinerary, Property 21: Day heroes are distinct and belong to their day
  it("Property 21: one hero per day, from that day, no shared photoRef, deterministic", () => {
    fc.assert(
      fc.property(daysArb, (days) => {
        const heroes = pickDayHeroes(days);

        // At most one hero per day (Map keyed by day) and only for existing days.
        expect(heroes.size).toBeLessThanOrEqual(days.length);

        const seen = new Set<string>();
        for (const [dayNo, hero] of heroes) {
          const day = days.find((d) => d.day === dayNo);
          expect(day).toBeDefined();
          // Belongs to the same day.
          const refs = (day!.activities as unknown as { photoRef?: string }[]).map(
            (a) => a.photoRef,
          );
          expect(refs).toContain(hero.photoRef);
          expect(isValidPhotoRef(hero.photoRef)).toBe(true);
          // Distinct across days.
          expect(seen.has(hero.photoRef)).toBe(false);
          seen.add(hero.photoRef);
        }

        // A day without a hero has only invalid or earlier-used refs.
        const used = new Set<string>();
        for (const d of days) {
          const h = heroes.get(d.day);
          if (h) {
            used.add(h.photoRef);
            continue;
          }
          for (const a of d.activities as unknown as { photoRef?: string }[]) {
            if (isValidPhotoRef(a.photoRef)) {
              expect(used.has(a.photoRef)).toBe(true);
            }
          }
        }

        // Deterministic.
        const again = pickDayHeroes(days);
        expect([...again.entries()]).toEqual([...heroes.entries()]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: trustworthy-itinerary, Property 21: Day heroes are distinct and belong to their day
  it("Property 21: a day whose only photos were used earlier has no hero", () => {
    const days = [
      { day: 1, date: "d", activities: [{ photoRef: refPool[0], title: "A" }] },
      { day: 2, date: "d", activities: [{ photoRef: refPool[0], title: "B" }] },
    ] as unknown as TripDay[];
    const heroes = pickDayHeroes(days);
    expect(heroes.get(1)?.photoRef).toBe(refPool[0]);
    expect(heroes.has(2)).toBe(false);
  });
});
