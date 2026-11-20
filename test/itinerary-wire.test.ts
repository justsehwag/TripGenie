import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  readBatchResponse,
  unavailable,
  validateBatchRequest,
} from "@/lib/itinerary/batch-wire";
import { cleanUsedName, sanitizeDisplayText } from "@/lib/itinerary/text";

const RUNS = { numRuns: 150 };

// ---------- Property 3 oracle ----------

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Independent statement of "valid request" from the design. */
function oracleValid(body: any): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const c = body.context;
  if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
  if (typeof c.destination !== "string") return false;
  const dl = c.destination.trim().length;
  if (dl < 1 || dl > 100) return false;
  const n = c.durationDays;
  if (!Number.isInteger(n) || n < 1 || n > 14) return false;
  const { fromDay, dayCount } = body;
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > 3) return false;
  if (!Number.isInteger(fromDay) || fromDay < 1 || fromDay + dayCount - 1 > n) return false;
  if (body.usedPlaces !== undefined) {
    if (!Array.isArray(body.usedPlaces) || body.usedPlaces.length > 100) return false;
    for (const u of body.usedPlaces) {
      if (typeof u !== "string" || u.length > 120) return false;
    }
  }
  if (body.startDate !== undefined && body.startDate !== null) {
    if (typeof body.startDate !== "string" || !isRealDate(body.startDate)) return false;
  }
  if (body.dayTripsUsed !== undefined && body.dayTripsUsed !== null) {
    const t = body.dayTripsUsed;
    if (!Number.isInteger(t) || t < 0 || t > 3) return false;
  }
  return true;
}

const destArb = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => s.trim().length > 0);

const isoDateArb = fc
  .tuple(fc.integer({ min: 2000, max: 2100 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
  .map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

/** A request that satisfies every rule. */
const validBodyArb = fc
  .record({
    destination: destArb,
    durationDays: fc.integer({ min: 1, max: 14 }),
    dayCount: fc.integer({ min: 1, max: 3 }),
    used: fc.array(fc.string({ maxLength: 120 }), { maxLength: 100 }),
    startDate: fc.option(isoDateArb, { nil: undefined }),
    dayTripsUsed: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
    pick: fc.nat(),
  })
  .filter((r) => r.dayCount <= r.durationDays)
  .map((r) => {
    const maxFrom = r.durationDays - r.dayCount + 1;
    const body: any = {
      action: "itinerary-batch",
      context: { destination: r.destination, durationDays: r.durationDays },
      fromDay: 1 + (r.pick % maxFrom),
      dayCount: r.dayCount,
      usedPlaces: r.used,
    };
    if (r.startDate !== undefined) body.startDate = r.startDate;
    if (r.dayTripsUsed !== undefined) body.dayTripsUsed = r.dayTripsUsed;
    return body;
  });

type Mutation = (b: any, salt: number) => void;
const mutations: Mutation[] = [
  (b) => { b.context.destination = ""; },
  (b) => { b.context.destination = "x".repeat(101); },
  (b) => { b.context.destination = 42; },
  (b) => { b.context.durationDays = 0; },
  (b) => { b.context.durationDays = 15; },
  (b) => { b.context.durationDays = 2.5; },
  (b) => { b.context.durationDays = "3"; },
  (b) => { b.dayCount = 0; },
  (b) => { b.dayCount = 4; },
  (b) => { b.dayCount = 1.5; },
  (b) => { b.fromDay = 0; },
  (b) => { b.fromDay = -3; },
  (b) => { b.fromDay = b.context.durationDays - b.dayCount + 2; },
  (b) => { b.fromDay = "1"; },
  (b) => { b.usedPlaces = Array.from({ length: 101 }, () => "a"); },
  (b) => { b.usedPlaces = ["ok", 5]; },
  (b) => { b.usedPlaces = ["y".repeat(121)]; },
  (b) => { b.usedPlaces = "not-an-array"; },
  (b) => { b.startDate = "2024-02-30"; },
  (b) => { b.startDate = "2024-13-01"; },
  (b) => { b.startDate = "tomorrow"; },
  (b) => { b.startDate = 20240101; },
  (b) => { b.dayTripsUsed = 4; },
  (b) => { b.dayTripsUsed = -1; },
  (b) => { b.dayTripsUsed = 1.5; },
  (b) => { delete b.context; },
  (b) => { b.context = "ctx"; },
  (b) => { delete b.dayCount; },
  (b) => { delete b.fromDay; },
];

describe("itinerary-wire: validateBatchRequest", () => {
  // Feature: trustworthy-itinerary, Property 3: Request validation accepts exactly the valid requests
  it("accepts every generated valid request and sanitises used names", () => {
    fc.assert(
      fc.property(validBodyArb, (body) => {
        expect(oracleValid(body)).toBe(true);
        const r = validateBatchRequest(body);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.totalDays).toBe(body.context.durationDays);
        expect(r.value.fromDay).toBe(body.fromDay);
        expect(r.value.dayCount).toBe(body.dayCount);
        expect(r.value.usedPlaces.length).toBeLessThanOrEqual(100);
        for (const u of r.value.usedPlaces) {
          expect(Array.from(u).length).toBeLessThanOrEqual(120);
          expect(u).not.toMatch(/[<>]/);
          expect(u.length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });

  // Feature: trustworthy-itinerary, Property 3: Request validation accepts exactly the valid requests
  it("rejects every single-fault mutation of a valid request", () => {
    fc.assert(
      fc.property(validBodyArb, fc.nat(mutations.length - 1), fc.nat(), (body, mi, salt) => {
        const copy = JSON.parse(JSON.stringify(body));
        mutations[mi](copy, salt);
        // The oracle decides: a mutation that happens to keep the body valid
        // (e.g. fromDay shift when the range allows it) must still agree.
        const r = validateBatchRequest(copy);
        expect(r.ok).toBe(oracleValid(copy));
      }),
      RUNS,
    );
  });

  // Feature: trustworthy-itinerary, Property 3: Request validation accepts exactly the valid requests
  it("agrees with the oracle on structured random bodies", () => {
    const loose = fc.record(
      {
        context: fc.oneof(
          fc.record(
            {
              destination: fc.oneof(fc.string({ maxLength: 120 }), fc.integer(), fc.constant(null)),
              durationDays: fc.oneof(fc.integer({ min: -2, max: 20 }), fc.double(), fc.string()),
            },
            { requiredKeys: [] },
          ),
          fc.anything(),
        ),
        fromDay: fc.oneof(fc.integer({ min: -2, max: 16 }), fc.double(), fc.string()),
        dayCount: fc.oneof(fc.integer({ min: -1, max: 5 }), fc.double(), fc.string()),
        usedPlaces: fc.oneof(
          fc.array(fc.oneof(fc.string({ maxLength: 130 }), fc.integer()), { maxLength: 110 }),
          fc.anything(),
        ),
        startDate: fc.oneof(isoDateArb, fc.string(), fc.constant(null), fc.integer()),
        dayTripsUsed: fc.oneof(fc.integer({ min: -2, max: 6 }), fc.double(), fc.constant(null)),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(loose, (body) => {
        expect(validateBatchRequest(body).ok).toBe(oracleValid(body));
      }),
      RUNS,
    );
  });

  // Feature: trustworthy-itinerary, Property 3: Request validation accepts exactly the valid requests
  it("never throws for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(() => validateBatchRequest(x)).not.toThrow();
        const r = validateBatchRequest(x);
        expect(typeof r.ok).toBe("boolean");
      }),
      { numRuns: 300 },
    );
    for (const x of [null, undefined, 0, "", [], () => 1, Symbol("s")]) {
      expect(() => validateBatchRequest(x)).not.toThrow();
      expect(validateBatchRequest(x).ok).toBe(false);
    }
  });
});

// ---------- Property 19 ----------

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

const nastyString = fc.oneof(
  fc.string({ maxLength: 300 }),
  fc.string({ unit: "binary", maxLength: 300 }),
  fc.array(
    fc.constantFrom(
      "<script>", "</script>", "<", ">", "\u0000", "\u0007", "\t", "\n", "\r\n", "\u0085",
      "\u2028", "\u200b", "\u202e", "\ufeff", "\u00a0", "  ", " ", "\ud800", "\udc00",
      "😀", "é", "abc", "Hotel", "x".repeat(200),
    ),
    { maxLength: 40 },
  ).map((a) => a.join("")),
);

describe("itinerary-wire: display text sanitising", () => {
  // Feature: trustworthy-itinerary, Property 19: Display text sanitising
  it("sanitizeDisplayText output is clean, bounded, collapsed and idempotent", () => {
    fc.assert(
      fc.property(nastyString, fc.integer({ min: 1, max: 200 }), (raw, max) => {
        const out = sanitizeDisplayText(raw, max);
        expect(out).not.toMatch(/[<>]/);
        expect(out).not.toMatch(CONTROL);
        expect(Array.from(out).length).toBeLessThanOrEqual(max);
        expect(out).not.toMatch(/\s\s/);
        expect(out).toBe(out.trim());
        expect(out).not.toMatch(/[^\S ]/); // only plain spaces remain as whitespace
        expect(hasLoneSurrogate(out)).toBe(false);
        expect(sanitizeDisplayText(out, max)).toBe(out);
      }),
      RUNS,
    );
  });

  // Feature: trustworthy-itinerary, Property 19: Display text sanitising
  it("handles non-strings and non-positive limits without throwing", () => {
    fc.assert(
      fc.property(fc.anything(), fc.oneof(fc.integer(), fc.double(), fc.constant(Infinity)), (raw, max) => {
        const out = sanitizeDisplayText(raw, max as number);
        expect(typeof out).toBe("string");
        expect(out).not.toMatch(/[<>]/);
        expect(out).not.toMatch(CONTROL);
        if (typeof raw !== "string" || !(max > 0)) expect(out).toBe("");
      }),
      RUNS,
    );
  });

  // Feature: trustworthy-itinerary, Property 19: Display text sanitising
  it("cleanUsedName is bounded to 120 code points and free of markup", () => {
    fc.assert(
      fc.property(nastyString, (raw) => {
        const out = cleanUsedName(raw);
        expect(Array.from(out).length).toBeLessThanOrEqual(120);
        expect(out).not.toMatch(/[<>]/);
        expect(out).not.toMatch(CONTROL);
        expect(cleanUsedName(out)).toBe(out);
      }),
      RUNS,
    );
  });

  // Feature: trustworthy-itinerary, Property 19: Display text sanitising
  it("examples: script tags, controls, surrogates, truncation", () => {
    expect(sanitizeDisplayText("<script>alert(1)</script>", 100)).toBe("scriptalert(1)/script");
    expect(sanitizeDisplayText("  a \n\t b\u0000c  ", 100)).toBe("a bc");
    expect(sanitizeDisplayText("ab\ud800cd", 100)).toBe("abcd");
    expect(sanitizeDisplayText("😀😀😀", 2)).toBe("😀😀");
    expect(sanitizeDisplayText(123, 10)).toBe("");
  });
});

// ---------- readBatchResponse examples ----------

function goodActivity(extra: Record<string, unknown> = {}) {
  return {
    time: "09:00",
    place: "Louvre Museum",
    area: "1st arr.",
    description: "Art.",
    cost: 20,
    verified: true,
    placeId: "ChIJabc",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Louvre&query_place_id=ChIJabc",
    ...extra,
  };
}

function goodResponse(over: Record<string, unknown> = {}): any {
  return {
    source: "model",
    fromDay: 1,
    dayCount: 2,
    days: [
      { day: 1, title: "Day one", activities: [goodActivity()] },
      { day: 2, title: "Day two", activities: [goodActivity({ place: "Orsay" })] },
    ],
    verifiedDays: [1, 2],
    withheldDays: [],
    truncated: false,
    stats: { proposed: 2, verified: 2, removed: 0, ms: 10 },
    ...over,
  };
}

describe("itinerary-wire: readBatchResponse examples", () => {
  it("accepts a well-formed model response", () => {
    const r = readBatchResponse(goodResponse());
    expect(r).not.toBeNull();
    expect(r?.verifiedDays).toEqual([1, 2]);
    expect(r?.days[0].activities[0].verified).toBe(true);
  });

  it("accepts the unavailable() outcome round-trip", () => {
    const u = unavailable({ fromDay: 4, dayCount: 3 }, "unverified", 12.4);
    expect(u.withheldDays).toEqual([4, 5, 6]);
    const r = readBatchResponse(JSON.parse(JSON.stringify(u)));
    expect(r).not.toBeNull();
    expect(r?.source).toBe("unavailable");
    expect(r?.reason).toBe("unverified");
  });

  it("returns null for unavailable without a reason", () => {
    const body = goodResponse({
      source: "unavailable",
      days: [],
      verifiedDays: [],
      withheldDays: [1, 2],
    });
    expect(readBatchResponse(body)).toBeNull();
  });

  it("returns null when verifiedDays does not match days", () => {
    expect(readBatchResponse(goodResponse({ verifiedDays: [1] }))).toBeNull();
    expect(readBatchResponse(goodResponse({ verifiedDays: [2, 1] }))).toBeNull();
    expect(readBatchResponse(goodResponse({ verifiedDays: [1, 3] }))).toBeNull();
  });

  it("strips verified/placeId/mapsUrl from an activity with an unsafe mapsUrl, keeping the rest", () => {
    const body = goodResponse();
    body.days[0].activities[0].mapsUrl = "javascript:alert(1)";
    const r = readBatchResponse(body);
    expect(r).not.toBeNull();
    const a: any = r!.days[0].activities[0];
    expect(a.verified).toBeUndefined();
    expect(a.placeId).toBeUndefined();
    expect(a.mapsUrl).toBeUndefined();
    expect(a.place).toBe("Louvre Museum");
    expect(a.cost).toBe(20);
    // the other day is untouched
    expect((r!.days[1].activities[0] as any).verified).toBe(true);
  });

  it("never throws for any input", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(() => readBatchResponse(x)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});
