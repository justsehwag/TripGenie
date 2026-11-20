import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import type { Activity, Itinerary } from "../types";
import { recomputeTotals } from "../itinerary-inr";
import { legMinutesUp } from "../itinerary/geo";
import { buildMapsUrl } from "../itinerary/maps-link";
import { sanitizeStoredVerification } from "../itinerary/revalidate";
import { applyProposal, validateProposal, type ApplyDeps } from "./proposal";
import { emptyHistory, canUndo, popEdit, pushEdit } from "./history";
import type { EditOp, EditProposal, PlaceRecord } from "./types";

const NOW = 1_700_000_000_000;
const deps: ApplyDeps = {
  estimate: (a: Activity): Activity => ({
    ...a,
    cost: 120,
    costBasis: "person",
    priceSource: "estimated",
    priceBasis: "Estimate",
  }),
  now: () => NOW,
};

// ---------- fixtures ----------

interface StopSeed {
  verified: boolean;
  cost: number;
  lat: number;
  lng: number;
  withLoc: boolean;
  minutes: number;
}

const stopSeedArb: fc.Arbitrary<StopSeed> = fc.record({
  verified: fc.boolean(),
  cost: fc.integer({ min: 0, max: 5000 }),
  lat: fc.integer({ min: 800, max: 2800 }),
  lng: fc.integer({ min: 7000, max: 8800 }),
  withLoc: fc.boolean(),
  minutes: fc.integer({ min: 6 * 60, max: 21 * 60 }),
});

function fmt(total: number): string {
  const t = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function makeStop(d: number, i: number, s: StopSeed): Activity {
  const a: Activity = {
    time: fmt(s.minutes),
    title: `S${d}-${i}`,
    description: `desc ${d}-${i}`,
    cost: s.cost,
  };
  if (s.verified) {
    a.verified = true;
    a.placeId = `pid-${d}-${i}`;
    a.placeName = a.title;
    a.mapsUrl = buildMapsUrl(a.placeId, a.title);
  }
  if (s.withLoc || s.verified) a.location = { lat: s.lat / 100, lng: s.lng / 100 };
  return a;
}

const itineraryArb: fc.Arbitrary<Itinerary> = fc
  .array(fc.array(stopSeedArb, { minLength: 0, maxLength: 5 }), { minLength: 1, maxLength: 4 })
  .map((days) =>
    recomputeTotals({
      title: "Trip",
      totalCost: 0,
      days: days.map((stops, di) => ({
        day: di + 1,
        date: "",
        title: `D${di + 1}`,
        theme: "",
        activities: stops.map((s, i) => makeStop(di + 1, i, s)),
        total: 0,
      })),
    }),
  );

let placeCounter = 0;
function placeFor(seed: number, lat: number, lng: number): PlaceRecord {
  const placeId = `new-${seed}-${placeCounter++}`;
  const name = `Place ${seed}`;
  return {
    placeId,
    name,
    address: `${seed} Some Road`,
    location: { lat: lat / 100, lng: lng / 100 },
    mapsUrl: buildMapsUrl(placeId, name),
  };
}

interface OpSeed {
  kind: number;
  a: number;
  b: number;
  c: number;
  lat: number;
  lng: number;
  minutes: number;
  withTime: boolean;
}

const opSeedArb: fc.Arbitrary<OpSeed> = fc.record({
  kind: fc.integer({ min: 0, max: 4 }),
  a: fc.nat({ max: 1000 }),
  b: fc.nat({ max: 1000 }),
  c: fc.nat({ max: 1000 }),
  lat: fc.integer({ min: 800, max: 2800 }),
  lng: fc.integer({ min: 7000, max: 8800 }),
  minutes: fc.integer({ min: 0, max: 1439 }),
  withTime: fc.boolean(),
});

/** Builds a proposal that is valid against `it` (falls back to add when the kind is not possible). */
function proposalFor(it: Itinerary, s: OpSeed): EditProposal {
  const days = it.days;
  const dayWithStops = days.filter((d) => d.activities.length > 0);
  const mk = (edit: EditOp, place?: PlaceRecord): EditProposal => ({
    version: 1,
    id: `p-${s.a}-${s.b}`,
    summary: "test edit",
    edit,
    ...(place ? { place } : {}),
  });
  const add = (): EditProposal => {
    const d = days[s.a % days.length];
    const place = placeFor(s.a, s.lat, s.lng);
    const index = s.withTime ? undefined : s.b % (d.activities.length + 1);
    const time = s.c % 2 === 0 ? fmt(s.minutes) : undefined;
    return mk(
      { op: "add", day: d.day, ...(index !== undefined ? { index } : {}), ...(time ? { time } : {}), placeId: place.placeId },
      place,
    );
  };
  if (s.kind === 0 || dayWithStops.length === 0) return add();
  const d = dayWithStops[s.a % dayWithStops.length];
  const index = s.b % d.activities.length;
  const cur = d.activities[index];
  const expectTitle = cur.title;
  switch (s.kind) {
    case 1: {
      const place = placeFor(s.a, s.lat, s.lng);
      return mk({ op: "replace", day: d.day, index, expectTitle, placeId: place.placeId }, place);
    }
    case 2:
      return mk({ op: "remove", day: d.day, index, expectTitle });
    case 3: {
      const others = days.filter((x) => x.day !== d.day);
      if (others.length === 0) return add();
      const dst = others[s.c % others.length];
      const toIndex = s.withTime ? undefined : s.c % (dst.activities.length + 1);
      return mk({
        op: "move",
        day: d.day,
        index,
        expectTitle,
        toDay: dst.day,
        ...(toIndex !== undefined ? { toIndex } : {}),
      });
    }
    default: {
      let m = s.minutes;
      if (fmt(m) === cur.time) m = (m + 1) % 1440;
      return mk({ op: "retime", day: d.day, index, expectTitle, time: fmt(m) });
    }
  }
}

function touchedDays(e: EditOp): number[] {
  return e.op === "move" ? [e.day, e.toDay] : [e.day];
}

// ---------- Property 3 ----------

describe("applyProposal produces a valid, consistent itinerary", () => {
  // Feature: trip-assistant-chat, Property 3: Applying a valid proposal yields a valid, consistent itinerary
  it("holds for every op kind over generated itineraries", () => {
    fc.assert(
      fc.property(itineraryArb, opSeedArb, (it, seed) => {
        const p = proposalFor(it, seed);
        const r = applyProposal(it, p, deps);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const out = r.itinerary;

        expect(sanitizeStoredVerification(out)).toBe(out);
        expect(recomputeTotals(out)).toStrictEqual(out);
        for (const d of out.days) {
          expect(d.total).toBe(d.activities.reduce((s, a) => s + a.cost, 0));
          for (const a of d.activities) {
            if (a.verified === true) expect(a.placeId && a.placeId.length > 0).toBeTruthy();
          }
        }
        expect(out.totalCost).toBe(out.days.reduce((s, d) => s + d.total, 0));

        if (p.edit.op === "add" || p.edit.op === "replace") {
          const day = out.days.find((d) => d.day === p.edit.day)!;
          const found = day.activities.filter((a) => a.placeId === p.place!.placeId);
          expect(found).toHaveLength(1);
        }

        for (const dn of touchedDays(p.edit)) {
          const acts = out.days.find((d) => d.day === dn)!.activities;
          acts.forEach((a, i) => {
            const b = acts[i + 1];
            if (b && a.location && b.location) {
              expect(a.travelToNextMin).toBe(Math.min(600, legMinutesUp(a.location, b.location)));
            } else {
              expect(a.travelToNextMin).toBeUndefined();
            }
          });
        }

        // inverse records the exact previous itinerary
        expect(r.inverse.before).toBe(it);
        expect(r.inverse.after).toBe(out);
        expect(r.inverse.at).toBe(NOW);
      }),
      { numRuns: 150 },
    );
  });

  it("does not mutate its input", () => {
    fc.assert(
      fc.property(itineraryArb, opSeedArb, (it, seed) => {
        const snapshot = JSON.stringify(it);
        applyProposal(it, proposalFor(it, seed), deps);
        expect(JSON.stringify(it)).toBe(snapshot);
      }),
      { numRuns: 100 },
    );
  });

  it("caps travel minutes at 600 for far-apart neighbours", () => {
    const it: Itinerary = recomputeTotals({
      title: "T",
      totalCost: 0,
      days: [
        {
          day: 1,
          date: "",
          title: "D1",
          theme: "",
          total: 0,
          activities: [
            { time: "09:00", title: "A", description: "", cost: 0, location: { lat: 8, lng: 77 } },
          ],
        },
      ],
    });
    const place = placeFor(1, 2800, 7000);
    const far = { ...place, location: { lat: -45, lng: 170 } };
    const r = applyProposal(
      it,
      { version: 1, id: "x", summary: "s", edit: { op: "add", day: 1, placeId: far.placeId }, place: far },
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.itinerary.days[0].activities[0].travelToNextMin).toBe(600);
  });
});

// ---------- Property 5 ----------

describe("apply then undo restores the itinerary", () => {
  // Feature: trip-assistant-chat, Property 5: Apply then undo restores the itinerary exactly
  it("single apply followed by undo is deep-equal to the original", () => {
    fc.assert(
      fc.property(itineraryArb, opSeedArb, (it, seed) => {
        const original = JSON.parse(JSON.stringify(it)) as Itinerary;
        const r = applyProposal(it, proposalFor(it, seed), deps);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const h = pushEdit(emptyHistory(), r.inverse);
        expect(canUndo(h, r.itinerary)).toBe(true);
        const popped = popEdit(h);
        expect(popped.edit).not.toBeNull();
        expect(popped.edit!.before).toStrictEqual(original);
        expect(popped.history.entries).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it("a sequence of applies undone in reverse restores the original", () => {
    fc.assert(
      fc.property(itineraryArb, fc.array(opSeedArb, { minLength: 1, maxLength: 6 }), (it, seeds) => {
        const original = JSON.parse(JSON.stringify(it)) as Itinerary;
        let cur = it;
        let h = emptyHistory();
        for (const s of seeds) {
          const r = applyProposal(cur, proposalFor(cur, s), deps);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          h = pushEdit(h, r.inverse);
          cur = r.itinerary;
        }
        expect(h.entries).toHaveLength(seeds.length);
        while (h.entries.length > 0) {
          expect(canUndo(h, cur)).toBe(true);
          const { history, edit } = popEdit(h);
          h = history;
          cur = edit!.before;
        }
        expect(cur).toStrictEqual(original);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------- Property 2 ----------

describe("validateProposal allow-list", () => {
  // Feature: trip-assistant-chat, Property 2: Proposals only use allow-listed place ids
  const idArb = fc.constantFrom("a", "b", "c", "d", "e", "f");
  it("accepts add/replace iff the placeId is allow-listed", () => {
    fc.assert(
      fc.property(
        itineraryArb,
        fc.array(idArb, { maxLength: 6 }),
        idArb,
        fc.boolean(),
        fc.boolean(),
        (it, listed, id, asSet, isReplace) => {
          const dayWithStops = it.days.find((d) => d.activities.length > 0);
          const day = isReplace && dayWithStops ? dayWithStops : it.days[0];
          const place = placeFor(1, 1500, 7700);
          const rec: PlaceRecord = { ...place, placeId: id };
          const edit: EditOp =
            isReplace && dayWithStops
              ? { op: "replace", day: day.day, index: 0, expectTitle: day.activities[0].title, placeId: id }
              : { op: "add", day: day.day, placeId: id };
          const p: EditProposal = { version: 1, id: "p", summary: "s", edit, place: rec };
          const allow = asSet ? new Set(listed) : listed;
          const res = validateProposal(it, p, allow);
          if (listed.includes(id)) {
            expect(res.ok).toBe(true);
          } else {
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe("not-allowed");
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it("remove, move and retime need no allow-listed id", () => {
    fc.assert(
      fc.property(itineraryArb, opSeedArb, (it, seed) => {
        const p = proposalFor(it, seed);
        if (p.edit.op === "add" || p.edit.op === "replace") return;
        expect(validateProposal(it, p, []).ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------- Examples: invalid edits never return ok ----------

describe("invalid edits are never applied", () => {
  const it0: Itinerary = recomputeTotals({
    title: "T",
    totalCost: 0,
    days: [
      {
        day: 1,
        date: "",
        title: "D1",
        theme: "",
        total: 0,
        activities: [makeStop(1, 0, { verified: true, cost: 100, lat: 1500, lng: 7700, withLoc: true, minutes: 540 })],
      },
      { day: 2, date: "", title: "D2", theme: "", total: 0, activities: [] },
    ],
  });
  const place = placeFor(9, 1500, 7700);
  const base = (edit: EditOp, pl?: PlaceRecord): EditProposal => ({
    version: 1,
    id: "p",
    summary: "s",
    edit,
    ...(pl ? { place: pl } : {}),
  });

  it("out-of-range day", () => {
    const p = base({ op: "add", day: 99, placeId: place.placeId }, place);
    expect(applyProposal(it0, p, deps).ok).toBe(false);
    expect(validateProposal(it0, p, [place.placeId]).ok).toBe(false);
    const r = base({ op: "remove", day: 99, index: 0, expectTitle: "S1-0" });
    expect(applyProposal(it0, r, deps).ok).toBe(false);
  });

  it("bad time", () => {
    for (const time of ["25:00", "9:30", "12:60", "noon", ""]) {
      const p = base({ op: "retime", day: 1, index: 0, expectTitle: "S1-0", time });
      expect(applyProposal(it0, p, deps).ok).toBe(false);
      expect(validateProposal(it0, p, []).ok).toBe(false);
      const a = base({ op: "add", day: 1, placeId: place.placeId, time }, place);
      expect(applyProposal(it0, a, deps).ok).toBe(false);
    }
  });

  it("mismatched or missing place record", () => {
    const wrong = { ...place, placeId: "other" };
    const p = base({ op: "add", day: 1, placeId: place.placeId }, wrong);
    expect(applyProposal(it0, p, deps).ok).toBe(false);
    expect(validateProposal(it0, p, [place.placeId]).ok).toBe(false);
    const none = base({ op: "add", day: 1, placeId: place.placeId });
    expect(applyProposal(it0, none, deps).ok).toBe(false);
    const badLoc = { ...place, location: { lat: 999, lng: 0 } };
    expect(applyProposal(it0, base({ op: "add", day: 1, placeId: place.placeId }, badLoc), deps).ok).toBe(false);
  });

  it("stale target title and bad move day", () => {
    const stale = base({ op: "remove", day: 1, index: 0, expectTitle: "Nope" });
    expect(applyProposal(it0, stale, deps).ok).toBe(false);
    const mv = base({ op: "move", day: 1, index: 0, expectTitle: "S1-0", toDay: 7 });
    expect(applyProposal(it0, mv, deps).ok).toBe(false);
    expect(validateProposal(it0, mv, []).ok).toBe(false);
  });
});
