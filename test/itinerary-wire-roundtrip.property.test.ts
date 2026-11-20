// Feature: places-first-itinerary, Property 21: The wire contract round-trips and rejects malformed bodies
// Validates: Requirements 10.4, 10.5, 10.6, 10.7, 10.8, 10.14
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { readBatchResponse, type BatchResponse } from "@/lib/itinerary/batch-wire";
import { cleanNewActivityFields } from "@/lib/itinerary/activity-fields";
import type { Activity, TripDay, WebDetail, WebDetails } from "@/lib/types";

const RUNS = { numRuns: 200 };
const text = (max: number, min = 0) => fc.string({ minLength: min, maxLength: max });
const nonNeg = fc.nat(100000).chain((n) => fc.constantFrom(n, n + 0.5, n + 0.25));
const idChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("");
const id = fc.array(fc.constantFrom(...idChars), { minLength: 1, maxLength: 12 }).map((a) => a.join(""));
const photoRef = fc.tuple(id, id).map(([p, q]) => `places/${p}/photos/${q}`);
const label = fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), { minLength: 1, maxLength: 10 }).map((a) => a.join(""));
const host = fc.tuple(label, fc.constantFrom("com", "org", "in", "co.uk")).map(([l, t]) => `${l}.example.${t}`);
const isoDate = fc
  .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) })
  .map((ms) => new Date(ms).toISOString());

const webDetail: fc.Arbitrary<WebDetail> = fc
  .record({ text: text(240, 1), host, path: label, checkedAt: isoDate })
  .map((r) => ({
    text: r.text,
    sourceUrl: `https://${r.host}/${r.path}`,
    sourceHost: r.host,
    checkedAt: r.checkedAt,
  }));

const webDetails: fc.Arbitrary<WebDetails> = fc.record(
  {
    checked: fc.boolean(),
    tip: webDetail,
    booking: webDetail,
    bestTime: webDetail,
    priceKind: fc.constantFrom("entry" as const, "typical" as const),
  },
  { requiredKeys: ["checked"] },
) as fc.Arbitrary<WebDetails>;

const activity: fc.Arbitrary<Activity> = fc
  .record(
    {
      time: text(8),
      title: text(30),
      description: text(60),
      cost: nonNeg,
      area: text(20),
      placeName: text(20),
      travelToNextMin: fc.nat(300),
      location: fc.record({ lat: fc.integer({ min: -90, max: 90 }), lng: fc.integer({ min: -180, max: 180 }) }),
      openingHours: text(300, 1).filter((s) => s.trim().length > 0),
      hoursLabel: fc.constantFrom("Typical hours" as const, "Hours not listed" as const),
      photos: fc.array(photoRef, { minLength: 1, maxLength: 3 }).filter((a) => new Set(a).size === a.length),
      webDetails,
    },
    { requiredKeys: ["time", "title", "description", "cost"] },
  )
  .chain((a) =>
    fc.boolean().map((v) =>
      v
        ? ({ ...a, verified: true, placeId: "ChIJ-abc_123", mapsUrl: "https://www.google.com/maps/place/?q=place_id:ChIJ-abc_123" } as Activity)
        : (a as Activity),
    ),
  );

const dayOf = (n: number): fc.Arbitrary<TripDay> =>
  fc
    .record({ date: text(10), title: text(20), theme: text(20), activities: fc.array(activity, { maxLength: 4 }), total: nonNeg, dayTrip: fc.boolean() })
    .map(({ dayTrip, ...r }) => ({ day: n, ...r, ...(dayTrip ? { dayTrip: true as const } : {}) }) as TripDay);

const source = fc.record({ title: text(30), host, path: label }).map((r) => ({
  title: r.title,
  url: `https://${r.host}/${r.path}`,
  host: r.host,
}));

const response: fc.Arbitrary<BatchResponse> = fc
  .record({ fromDay: fc.integer({ min: 1, max: 14 }), len: fc.integer({ min: 1, max: 3 }) })
  .filter(({ fromDay, len }) => fromDay + len - 1 <= 14)
  .chain(({ fromDay, len }) => {
    const range = Array.from({ length: len }, (_, i) => fromDay + i);
    return fc
      .record({
        unavailable: fc.boolean(),
        reason: fc.constantFrom("not-configured" as const, "unavailable" as const, "unverified" as const),
        withReason: fc.boolean(),
        kept: fc.array(fc.boolean(), { minLength: len, maxLength: len }),
        truncated: fc.boolean(),
        sources: fc.option(fc.array(source, { minLength: 1, maxLength: 3 }), { nil: undefined }),
        stats: fc.record({ proposed: nonNeg, verified: nonNeg, removed: nonNeg, ms: nonNeg }),
      })
      .chain((m) => {
        const dayNums = m.unavailable ? [] : range.filter((_, i) => m.kept[i]);
        return fc.tuple(...dayNums.map(dayOf)).map((days) => {
          const withheld = range.filter((d) => !dayNums.includes(d));
          const r: BatchResponse = {
            source: m.unavailable ? "unavailable" : "model",
            fromDay,
            dayCount: len,
            days,
            verifiedDays: dayNums,
            withheldDays: withheld,
            truncated: m.truncated,
            stats: m.stats,
          };
          if (m.unavailable || m.withReason) r.reason = m.reason;
          if (m.sources) r.sources = m.sources;
          return r;
        });
      });
  });

const wire = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe("Property 21: wire contract round-trip", () => {
  it("readBatchResponse(JSON round-trip of r) deep-equals r, withheldDays ascending", () => {
    fc.assert(
      fc.property(response, (r) => {
        const back = readBatchResponse(wire(r));
        expect(back).toEqual(r);
        const w = back!.withheldDays;
        expect(w).toEqual([...w].sort((a, b) => a - b));
      }),
      RUNS,
    );
  });

  it("returns withheldDays ascending even when the wire order is not", () => {
    fc.assert(
      fc.property(response, fc.integer({ min: 0, max: 1000 }), (r, seed) => {
        const shuffled = [...r.withheldDays].sort((a, b) => ((a * 7919 + seed) % 13) - ((b * 7919 + seed) % 13));
        const back = readBatchResponse(wire({ ...r, withheldDays: shuffled }));
        expect(back).not.toBeNull();
        expect(back!.withheldDays).toEqual([...r.withheldDays].sort((a, b) => a - b));
      }),
      RUNS,
    );
  });

  it("cleanNewActivityFields leaves generated valid activities untouched", () => {
    fc.assert(
      fc.property(activity, (a) => {
        expect(cleanNewActivityFields(wire(a) as Record<string, unknown>)).toBeNull();
      }),
      RUNS,
    );
  });

  it("drops an invalid Web_Detail but keeps the stop and its other valid details", () => {
    fc.assert(
      fc.property(response.filter((r) => r.days.some((d) => d.activities.length > 0)), webDetail, webDetail, (r, good, bad) => {
        const wireR = wire(r) as { days: { activities: Record<string, unknown>[] }[] };
        const act = wireR.days.find((d) => d.activities.length > 0)!.activities[0];
        act.webDetails = { checked: true, tip: good, booking: { ...bad, sourceUrl: "http://" + bad.sourceHost + "/x" }, bestTime: { ...bad, checkedAt: "not a date" } };
        const back = readBatchResponse(wireR);
        expect(back).not.toBeNull();
        const out = back!.days.find((d) => d.activities.length > 0)!.activities[0];
        expect(out.title).toBe(act.title);
        expect(out.webDetails).toEqual({ checked: true, tip: good });
      }),
      RUNS,
    );
  });
});

describe("Property 21: malformed bodies return null and never throw", () => {
  type Mut = (w: Record<string, any>) => void;
  const mutations: [string, Mut][] = [
    ["bad source", (w) => { w.source = "other"; }],
    ["fromDay not int", (w) => { w.fromDay = 1.5; }],
    ["fromDay zero", (w) => { w.fromDay = 0; }],
    ["dayCount too large", (w) => { w.dayCount = 4; }],
    ["range beyond max trip", (w) => { w.fromDay = 14; w.dayCount = 3; }],
    ["reason invalid", (w) => { w.reason = "nope"; }],
    ["unavailable without reason", (w) => { w.source = "unavailable"; w.days = []; w.verifiedDays = []; delete w.reason; }],
    ["days not an array", (w) => { w.days = {}; }],
    ["day outside range", (w) => { w.days = [{ day: w.fromDay + w.dayCount, date: "", title: "", theme: "", activities: [], total: 0 }]; w.verifiedDays = [w.fromDay + w.dayCount]; w.withheldDays = []; }],
    ["activities not records", (w) => { w.days = [{ day: w.fromDay, date: "", title: "", theme: "", activities: [1], total: 0 }]; w.verifiedDays = [w.fromDay]; w.withheldDays = []; }],
    ["verifiedDays disagree", (w) => { w.verifiedDays = [...w.verifiedDays, 99]; }],
    ["withheld out of range", (w) => { w.withheldDays = [...w.withheldDays, w.fromDay + w.dayCount]; }],
    ["withheld duplicate", (w) => { const x = w.fromDay + w.dayCount; w.days = []; w.verifiedDays = []; w.withheldDays = [w.fromDay, w.fromDay]; void x; }],
    ["withheld non-int", (w) => { w.withheldDays = ["a"]; }],
    ["truncated not boolean", (w) => { w.truncated = "yes"; }],
    ["stats missing", (w) => { delete w.stats; }],
    ["stats negative", (w) => { w.stats.ms = -1; }],
    ["stats not number", (w) => { w.stats.proposed = "3"; }],
  ];

  it.each(mutations)("rejects: %s", (_name, mut) => {
    fc.assert(
      fc.property(
        response.filter((r) => r.dayCount >= 1 && r.fromDay + r.dayCount - 1 <= 14),
        (r) => {
          const w = wire(r) as Record<string, any>;
          // start from a "model" response with no days where needed by the mutation
          if (_name === "withheld duplicate" && r.dayCount < 1) return;
          mut(w);
          expect(() => readBatchResponse(w)).not.toThrow();
          expect(readBatchResponse(w)).toBeNull();
        },
      ),
      RUNS,
    );
  });

  it("rejects days that are not ascending", () => {
    fc.assert(
      fc.property(response.filter((r) => r.days.length >= 2), (r) => {
        const w = wire(r) as Record<string, any>;
        w.days = [...w.days].reverse();
        expect(readBatchResponse(w)).toBeNull();
      }),
      RUNS,
    );
  });

  it("rejects an unavailable response that carries days", () => {
    fc.assert(
      fc.property(response.filter((r) => r.days.length >= 1), (r) => {
        const w = wire({ ...r, source: "unavailable", reason: "unavailable" });
        expect(readBatchResponse(w)).toBeNull();
      }),
      RUNS,
    );
  });

  it("never throws on arbitrary JSON values", () => {
    fc.assert(
      fc.property(fc.anything(), fc.jsonValue(), (a, b) => {
        expect(() => readBatchResponse(a)).not.toThrow();
        expect(() => readBatchResponse(b)).not.toThrow();
        expect(readBatchResponse(b)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});
