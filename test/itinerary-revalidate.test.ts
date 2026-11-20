import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sanitizeStoredVerification } from "@/lib/itinerary/revalidate";
import { sanitizeStoredItinerary } from "@/lib/web-price-sources";
import { fromSharedContext, toSharedContext } from "@/lib/history/record-codec";
import { hasVerificationData } from "@/lib/itinerary/completeness";
import { buildMapsUrl } from "@/lib/itinerary/maps-link";
import type { Activity, Itinerary, TripDay } from "@/lib/types";

const RUNS = { numRuns: 100 };
const idArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);
const nameArb = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,15}$/);

/** A valid verified stop with real-shaped verification data. */
const validStopArb: fc.Arbitrary<Activity> = fc
  .record({
    placeId: idArb,
    name: nameArb,
    ph: idArb,
    ph2: idArb,
    lat: fc.double({ min: -90, max: 90, noNaN: true }),
    lng: fc.double({ min: -180, max: 180, noNaN: true }),
    travel: fc.integer({ min: 0, max: 600 }),
    cost: fc.integer({ min: 0, max: 5000 }),
    withTravel: fc.boolean(),
    withPhoto: fc.boolean(),
  })
  .map((r) => {
    const a: Activity = {
      time: "09:00",
      title: r.name,
      description: "d",
      cost: r.cost,
      placeId: r.placeId,
      placeName: r.name,
      verified: true,
      mapsUrl: buildMapsUrl(r.placeId, r.name),
      location: { lat: r.lat, lng: r.lng },
    };
    if (r.withPhoto) a.photoRef = `places/${r.ph}/photos/${r.ph2}`;
    if (r.withTravel) a.travelToNextMin = r.travel;
    return a;
  });

const badUrlArb = fc.constantFrom(
  "javascript:alert(1)",
  "http://www.google.com/maps/x",
  "https://evil.example/maps/x",
  "https://www.google.com.evil.com/maps",
  "https://www.google.com/search?q=1",
  "",
  "not a url",
);

type Case = { act: Activity; expected: Activity };

/** Corrupt a valid stop one way and compute the expected sanitized result. */
const caseArb: fc.Arbitrary<Case> = fc
  .tuple(
    validStopArb,
    fc.constantFrom("none", "emptyId", "badUrl", "badPhoto", "badLoc", "badTravel"),
    badUrlArb,
  )
  .map(([a, kind, url]) => {
    const act: Activity = { ...a };
    const expected: Activity = { ...a };
    const strip = (o: Activity, ...ks: string[]) => {
      for (const k of ks) delete (o as unknown as Record<string, unknown>)[k];
    };
    switch (kind) {
      case "emptyId":
        act.placeId = "";
        expected.placeId = undefined;
        strip(expected, "verified", "placeId", "mapsUrl");
        break;
      case "badUrl":
        act.mapsUrl = url;
        strip(expected, "verified", "placeId", "mapsUrl");
        break;
      case "badPhoto":
        (act as unknown as Record<string, unknown>).photoRef = "places/a b/photos/c";
        strip(expected, "photoRef");
        break;
      case "badLoc":
        (act as unknown as Record<string, unknown>).location = { lat: 91, lng: 0 };
        strip(expected, "location");
        break;
      case "badTravel":
        (act as unknown as Record<string, unknown>).travelToNextMin = 601;
        strip(expected, "travelToNextMin");
        break;
    }
    return { act, expected };
  });

function itinOf(acts: Activity[]): Itinerary {
  const day: TripDay = {
    day: 1,
    date: "2025-01-01",
    title: "t",
    theme: "x",
    activities: acts,
    total: 0,
  };
  return { title: "T", totalCost: 0, days: [day] };
}

describe("sanitizeStoredVerification", () => {
  // Feature: trustworthy-itinerary, Property 22: Stored verification data is re-validated
  it("Property 22: re-validates stored verification data", () => {
    fc.assert(
      fc.property(fc.array(caseArb, { minLength: 1, maxLength: 6 }), (cases) => {
        const input = itinOf(cases.map((c) => c.act));
        const out = sanitizeStoredVerification(input);
        const outActs = out.days[0].activities;
        expect(outActs).toHaveLength(cases.length);
        cases.forEach((c, i) => {
          expect(outActs[i]).toEqual(c.expected);
          if (c.act.placeId === c.expected.placeId && JSON.stringify(c.act) === JSON.stringify(c.expected)) {
            expect(outActs[i]).toBe(c.act); // valid activity untouched (same reference)
          }
        });
        // idempotent
        expect(sanitizeStoredVerification(out)).toEqual(out);
        // same object when nothing changed
        const unchanged = cases.every((c) => JSON.stringify(c.act) === JSON.stringify(c.expected));
        if (unchanged) expect(out).toBe(input);
      }),
      RUNS,
    );
  });

  // Feature: trustworthy-itinerary, Property 22: Stored verification data is re-validated
  it("Property 22: payload without new fields is returned unchanged and has no verification data", () => {
    const plainAct = fc.record({
      time: fc.constant("10:00"),
      title: nameArb,
      description: nameArb,
      cost: fc.integer({ min: 0, max: 9999 }),
    });
    fc.assert(
      fc.property(fc.array(plainAct, { maxLength: 6 }), (acts) => {
        const input = itinOf(acts as Activity[]);
        expect(hasVerificationData(input)).toBe(false);
        expect(sanitizeStoredVerification(input)).toBe(input);
      }),
      RUNS,
    );
  });

  it("example: payload with none of the new fields returns the same object", () => {
    const input = itinOf([{ time: "09:00", title: "A", description: "d", cost: 10 }]);
    expect(sanitizeStoredVerification(input)).toBe(input);
    expect(sanitizeStoredItinerary(input)).toEqual(input);
  });

  it("example: verified activity with a javascript: mapsUrl loses only the three verification fields", () => {
    const act: Activity = {
      time: "09:00",
      title: "Temple",
      description: "d",
      cost: 5,
      area: "Old Town",
      placeName: "Temple",
      verified: true,
      placeId: "abc",
      mapsUrl: "javascript:alert(1)",
      location: { lat: 1, lng: 2 },
      photoRef: "places/abc/photos/xyz",
      travelToNextMin: 12,
    };
    const out = sanitizeStoredItinerary(itinOf([act]));
    expect(out.days[0].activities[0]).toEqual({
      time: "09:00",
      title: "Temple",
      description: "d",
      cost: 5,
      area: "Old Town",
      placeName: "Temple",
      location: { lat: 1, lng: 2 },
      photoRef: "places/abc/photos/xyz",
      travelToNextMin: 12,
    });
  });
});

const daysArb = (n: number): fc.Arbitrary<TripDay[]> =>
  fc.array(validStopArb, { minLength: 1, maxLength: 3 }).map((acts) =>
    Array.from({ length: n }, (_, i) => ({ day: i + 1, date: "", title: `D${i + 1}`, theme: "x", activities: acts, total: 0 })),
  );

describe("history codec round trip", () => {
  // Feature: trustworthy-itinerary, Property 23: History codec round trip with completeness
  it("Property 23: pending days move to withheld and the rest round-trips", () => {
    const arb = fc
      .integer({ min: 1, max: 10 })
      .chain((n) =>
        fc.tuple(
          fc.constant(n),
          fc.array(fc.constantFrom<"v" | "w" | "p">("v", "w", "p"), { minLength: n, maxLength: n }),
          fc.array(validStopArb, { minLength: 1, maxLength: 3 }),
        ),
      );
    fc.assert(
      fc.property(arb, ([n, states, acts]) => {
        const verifiedDays: number[] = [];
        const withheldDays: number[] = [];
        const pendingDays: number[] = [];
        states.forEach((s, i) => (s === "v" ? verifiedDays : s === "w" ? withheldDays : pendingDays).push(i + 1));
        const days: TripDay[] = verifiedDays.map((d) => ({
          day: d,
          date: "2025-01-0" + (d % 9 || 9),
          title: `D${d}`,
          theme: "x",
          activities: acts,
          total: 0,
        }));
        const completeness = {
          requestedDays: n,
          verifiedDays,
          withheldDays,
          ...(pendingDays.length ? { pendingDays } : {}),
        };
        const itinerary: Itinerary = { title: "T", totalCost: 0, days, completeness };
        const plan = { context: { destination: "Bali" }, dates: {}, itinerary };
        const back = toSharedContext(fromSharedContext(plan)).itinerary!;
        const expectedWithheld = [...withheldDays, ...pendingDays].sort((a, b) => a - b);
        expect(back).toEqual({
          ...itinerary,
          completeness: { requestedDays: n, verifiedDays, withheldDays: expectedWithheld },
        });
        expect(back.completeness).not.toHaveProperty("pendingDays");
      }),
      RUNS,
    );
  });

  // Feature: trustworthy-itinerary, Property 23: History codec round trip with completeness
  it("Property 23: itinerary without completeness round-trips unchanged", () => {
    fc.assert(
      fc.property(daysArb(3), (days) => {
        const itinerary: Itinerary = { title: "T", totalCost: 0, days };
        const plan = { context: {}, dates: {}, itinerary };
        expect(toSharedContext(fromSharedContext(plan))).toEqual(plan);
      }),
      RUNS,
    );
  });

  it("example: a saved partial itinerary reopens with its withheld days", () => {
    const [d1] = [1].map((d) => ({ day: d, date: "", title: "D1", theme: "x", activities: [], total: 0 }));
    const itinerary: Itinerary = {
      title: "T",
      totalCost: 0,
      days: [d1],
      completeness: { requestedDays: 3, verifiedDays: [1], withheldDays: [2], pendingDays: [3] },
    };
    const back = toSharedContext(fromSharedContext({ context: {}, dates: {}, itinerary })).itinerary!;
    expect(back.completeness).toEqual({ requestedDays: 3, verifiedDays: [1], withheldDays: [2, 3] });
    expect(back.days).toHaveLength(1);
  });
});
