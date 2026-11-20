import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { checkPolish, type PolishContext } from "../lib/itinerary/polish-check";
import type { DaySpec } from "../lib/itinerary/scheduler";
import { dayLimits } from "../lib/itinerary/pace";
import { DESC_CHARS, TITLE_CHARS } from "../lib/itinerary/constants";
import type { PlaceCandidate } from "../lib/providers/google-places";

type Out = { days: Array<{ day: number; title: string; stops: Array<{ placeId: string; sentence: string }> }> };

function cand(id: string, n: number, o: Partial<PlaceCandidate> = {}): PlaceCandidate {
  return {
    placeId: id,
    name: id,
    address: "1 Road, Old Town, France",
    location: { lat: 0.001 * n, lng: 0 },
    rating: 4,
    userRatingCount: 100,
    hours: null,
    utcOffsetMinutes: null,
    types: [],
    primaryType: "tourist_attraction",
    businessStatus: "OPERATIONAL",
    googleMapsUri: null,
    photos: [],
    ...o,
  };
}

const WORDS = ["lovely", "quiet", "spot", "with", "views", "stroll", "here", "then", "this", "garden"];
const TITLES: string[][] = [
  ["Old Town walk", "Harbour morning", "Gallery hop"],
  ["Quiet mornings", "River side", "Market lanes"],
  ["Hilltop views", "Temple trail", "Garden day"],
];

function shuffle<T>(arr: T[], r: number[], off: number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = r[(off + i) % r.length] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

interface Batch {
  ctx: PolishContext;
  valid: Out;
  special: string;
}

const batchArb = fc
  .record({
    total: fc.integer({ min: 2, max: 3 }),
    w0: fc.integer({ min: 0, max: 6 }),
    r: fc.array(fc.nat({ max: 1000 }), { minLength: 40, maxLength: 40 }),
    titleIdx: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 3, maxLength: 3 }),
    sentences: fc.array(
      fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 12 }).map((w) => w.join(" ") + "."),
      { minLength: 9, maxLength: 9 },
    ),
  })
  .map(({ total, w0, r, titleIdx, sentences }): Batch => {
    const days: PolishContext["days"] = [];
    const out: Out = { days: [] };
    let special = "";
    let k = 0;
    for (let d = 1; d <= total; d++) {
      const weekday = (w0 + d - 1) % 7;
      const lim = dayLimits("balanced", d, total);
      const lo = Math.max(1, lim.min);
      const hi = Math.max(lo, Math.min(lim.max, 3));
      const n = lo + (r[d] % (hi - lo + 1));
      const spec: DaySpec = { day: d, date: null, weekday, limits: lim, earliestMin: 540 };
      const stops: PlaceCandidate[] = [];
      for (let i = 0; i < n; i++) {
        const id = `p${d}x${i}`;
        if (d === 2 && i === 0) {
          // open only on day 2's weekday, 09:00 to 20:00
          special = id;
          stops.push(
            cand(id, k++, {
              hours: {
                periods: [{ open: { day: weekday, hour: 9, minute: 0 }, close: { day: weekday, hour: 20, minute: 0 } }],
                weekdayDescriptions: [],
              },
            }),
          );
        } else stops.push(cand(id, k++));
      }
      days.push({ spec, stops });
      const order = shuffle(stops, r, d * 7);
      out.days.push({
        day: d,
        title: TITLES[d - 1][titleIdx[d - 1]],
        stops: order.map((c, i) => ({ placeId: c.placeId, sentence: sentences[(d - 1) * 3 + (i % 3)] })),
      });
    }
    return { ctx: { days, dates: days.map(() => null) }, valid: out, special };
  });

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const BAD_TEXT = [
  "₹50", "$5", "€3", "£2", "¥9", "INR", "usd", "Eur", "gbp", "Rs", "Rs.", "9:30", "10:05", "5 pm", "10AM", "7 Am",
  "confirmed", "Confirmed", "BOOKABLE", "bookable",
];

const KEYS = ["note", "theme", "startMin", "time", "price", "id", "x"];

type Mut = (b: Batch, r: number, s: string, t: string) => Out | unknown;

// Each mutation applies exactly one fault to a valid output.
const MUTATIONS: Array<[string, Mut]> = [
  ["added placeId", (b, r) => {
    const o = clone(b.valid);
    o.days[r % o.days.length].stops.push({ placeId: `fresh-${r}`, sentence: "extra place" });
    return o;
  }],
  ["added known placeId copy", (b, r) => {
    const o = clone(b.valid);
    const all = o.days.flatMap((d) => d.stops);
    o.days[r % o.days.length].stops.push({ placeId: all[r % all.length].placeId, sentence: "again" });
    return o;
  }],
  ["removed placeId", (b, r) => {
    const o = clone(b.valid);
    const d = o.days[r % o.days.length];
    d.stops.splice(r % d.stops.length, 1);
    return o;
  }],
  ["duplicated placeId", (b, r) => {
    const o = clone(b.valid);
    const all = o.days.flatMap((d) => d.stops);
    // overwrite one stop's id with another stop's id, so counts stay equal
    const a = all[r % all.length];
    const other = all.find((s) => s.placeId !== a.placeId)!;
    a.placeId = other.placeId;
    return o;
  }],
  ["unknown placeId", (b, r) => {
    const o = clone(b.valid);
    const all = o.days.flatMap((d) => d.stops);
    all[r % all.length].placeId = `unknown-${r}`;
    return o;
  }],
  ["extra field top", (b, r, k) => ({ ...clone(b.valid), [k]: r })],
  ["extra field day", (b, r, k) => {
    const o = clone(b.valid) as unknown as { days: Array<Record<string, unknown>> };
    o.days[r % o.days.length][k] = r;
    return o;
  }],
  ["extra field stop", (b, r, k) => {
    const o = clone(b.valid) as unknown as { days: Array<{ stops: Array<Record<string, unknown>> }> };
    const d = o.days[r % o.days.length];
    d.stops[r % d.stops.length][k] = r;
    return o;
  }],
  ["fewer days", (b) => {
    const o = clone(b.valid);
    o.days.pop();
    return o;
  }],
  ["more days", (b) => {
    const o = clone(b.valid);
    o.days.push({ day: o.days.length + 1, title: "Bonus day", stops: [] });
    return o;
  }],
  ["wrong day number", (b) => {
    const o = clone(b.valid);
    o.days[o.days.length - 1].day = 99;
    return o;
  }],
  ["duplicate day number", (b) => {
    const o = clone(b.valid);
    o.days[1].day = o.days[0].day;
    return o;
  }],
  ["currency/clock/claim in title", (b, r, _k, t) => {
    const o = clone(b.valid);
    const d = o.days[r % o.days.length];
    d.title = r % 2 ? `${d.title} ${t}` : `${t} ${d.title}`;
    return o;
  }],
  ["currency/clock/claim in sentence", (b, r, _k, t) => {
    const o = clone(b.valid);
    const d = o.days[r % o.days.length];
    const s = d.stops[r % d.stops.length];
    s.sentence = r % 2 ? `${s.sentence} ${t}` : `${t} ${s.sentence}`;
    return o;
  }],
  ["title too long", (b, r) => {
    const o = clone(b.valid);
    o.days[r % o.days.length].title = "a".repeat(TITLE_CHARS + 1 + (r % 40));
    return o;
  }],
  ["sentence too long", (b, r) => {
    const o = clone(b.valid);
    const d = o.days[r % o.days.length];
    d.stops[r % d.stops.length].sentence = "a".repeat(DESC_CHARS + 1 + (r % 40));
    return o;
  }],
  ["empty title", (b, r) => {
    const o = clone(b.valid);
    o.days[r % o.days.length].title = r % 2 ? "" : "   ";
    return o;
  }],
  ["empty sentence", (b, r) => {
    const o = clone(b.valid);
    const d = o.days[r % o.days.length];
    d.stops[r % d.stops.length].sentence = r % 2 ? "" : "  ";
    return o;
  }],
  ["stop moved to a day it is closed", (b) => {
    // swap the day-2-only stop with a stop of day 1
    const o = clone(b.valid);
    const d1 = o.days[0];
    const d2 = o.days[1];
    const i2 = d2.stops.findIndex((s) => s.placeId === b.special);
    const tmp = d1.stops[0];
    d1.stops[0] = d2.stops[i2];
    d2.stops[i2] = tmp;
    return o;
  }],
  ["day over its stop maximum / other day emptied", (b) => {
    const o = clone(b.valid);
    o.days[0].stops.push(...o.days[1].stops);
    o.days[1].stops = [];
    return o;
  }],
  ["non-object output", (_b, r) => [null, 5, "x", [], undefined][r % 5]],
];

describe("Polish_Checker rejects every violating output", () => {
  // Feature: places-first-itinerary, Property 13: Polish_Checker rejects every violating output
  // Validates: Requirements 7.3, 7.4, 7.5, 7.10
  it("accepts an unmutated valid output (any in-day order)", () => {
    fc.assert(
      fc.property(batchArb, (b) => {
        const v = checkPolish(b.ctx, b.valid);
        expect(v.ok).toBe(true);
        if (v.ok) {
          expect(v.days.map((d) => d.day)).toEqual(b.valid.days.map((d) => d.day));
          expect(new Set(v.days.map((d) => d.title.toLowerCase())).size).toBe(v.days.length);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: places-first-itinerary, Property 13: Polish_Checker rejects every violating output
  it("rejects each single-fault mutation of a valid output", () => {
    fc.assert(
      fc.property(
        batchArb,
        fc.integer({ min: 0, max: MUTATIONS.length - 1 }),
        fc.nat({ max: 1000 }),
        fc.constantFrom(...KEYS),
        fc.constantFrom(...BAD_TEXT),
        (b, mi, r, key, bad) => {
          // the untampered output is accepted, so any rejection comes from the mutation
          expect(checkPolish(b.ctx, b.valid).ok).toBe(true);
          const [name, mutate] = MUTATIONS[mi];
          const v = checkPolish(b.ctx, mutate(b, r, key, bad));
          if (v.ok) throw new Error(`mutation accepted: ${name}`);
          expect(v.ok).toBe(false);
        },
      ),
      { numRuns: 600 },
    );
  });

  // Feature: places-first-itinerary, Property 13: Polish_Checker rejects every violating output
  it("rejects every mutation kind at least once per run set", () => {
    for (const [name, mutate] of MUTATIONS) {
      fc.assert(
        fc.property(batchArb, fc.nat({ max: 1000 }), fc.constantFrom(...KEYS), fc.constantFrom(...BAD_TEXT), (b, r, key, bad) => {
          const v = checkPolish(b.ctx, mutate(b, r, key, bad));
          if (v.ok) throw new Error(`mutation accepted: ${name}`);
        }),
        { numRuns: 100 },
      );
    }
  });
});
