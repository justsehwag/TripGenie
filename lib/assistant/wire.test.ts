import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_BODY_BYTES,
  MAX_HISTORY_TURNS,
  MAX_MESSAGE_CHARS,
  parseProposal,
  parseRequest,
  parseRequestText,
  printProposal,
  trimHistory,
  utf8ByteLength,
  withinByteLimit,
} from "./wire";
import type { ChatTurn, EditOp, EditProposal, PlaceRecord } from "./types";

const RUNS = { numRuns: 150 };

/* ---------------------------- generators ---------------------------- */
const word = (max: number) =>
  fc
    .string({ minLength: 1, maxLength: max })
    .filter((s) => s.length > 0 && s.trim() === s);

const timeArb = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);

const dayArb = fc.integer({ min: 1, max: 30 });
const idxArb = fc.integer({ min: 0, max: 19 });
const insertIdxArb = fc.integer({ min: 0, max: 20 });
const opt = <T,>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });

const editArb: fc.Arbitrary<EditOp> = fc.oneof(
  fc.record({ op: fc.constant("add" as const), day: dayArb, index: opt(insertIdxArb), time: opt(timeArb), placeId: word(300) }),
  fc.record({ op: fc.constant("replace" as const), day: dayArb, index: idxArb, expectTitle: word(200), placeId: word(300) }),
  fc.record({ op: fc.constant("remove" as const), day: dayArb, index: idxArb, expectTitle: word(200) }),
  fc.record({
    op: fc.constant("move" as const),
    day: dayArb,
    index: idxArb,
    expectTitle: word(200),
    toDay: dayArb,
    toIndex: opt(insertIdxArb),
    time: opt(timeArb),
  }),
  fc.record({ op: fc.constant("retime" as const), day: dayArb, index: idxArb, expectTitle: word(200), time: timeArb }),
);

const coord = (limit: number) => fc.integer({ min: -limit * 100, max: limit * 100 }).map((n) => n / 100);

const placeArb: fc.Arbitrary<PlaceRecord> = fc.record({
  placeId: word(300),
  name: word(200),
  address: fc.string({ maxLength: 600 }),
  area: opt(word(200)),
  location: fc.record({ lat: coord(90), lng: coord(180) }),
  mapsUrl: fc.string({ maxLength: 2000 }),
  photoRef: opt(word(500)),
  photos: opt(fc.array(fc.string({ minLength: 1, maxLength: 500 }), { minLength: 1, maxLength: 3 })),
  openingHours: opt(word(200)),
  hoursLabel: opt(fc.constantFrom("Typical hours" as const, "Hours not listed" as const)),
  rating: opt(fc.integer({ min: 0, max: 50 }).map((n) => n / 10)),
  visitMin: opt(fc.integer({ min: 1, max: 1440 })),
});

const priceArb = fc.record({
  inr: fc.integer({ min: 0, max: 10_000_000 }),
  sourceUrl: fc.string({ maxLength: 200 }).map((s) => `https://${s}`),
  sourceHost: word(200),
  checkedAt: word(60),
  basis: fc.string({ maxLength: 200 }),
});

const proposalArb: fc.Arbitrary<EditProposal> = fc.record({
  version: fc.constant(1 as const),
  id: word(64),
  summary: word(200),
  edit: editArb,
  place: opt(placeArb),
  price: opt(priceArb),
});

/* ----------------------------- Property 1 --------------------------- */
describe("wire: proposal serialization", () => {
  // Feature: trip-assistant-chat, Property 1: Proposal serialization round trip
  // Validates: Requirements 14.3, 14.4
  it("parseProposal(printProposal(p)) equals p and print-parse-print is stable", () => {
    fc.assert(
      fc.property(proposalArb, (p) => {
        const text = printProposal(p);
        const parsed = parseProposal(text);
        expect(parsed).toEqual(p);
        expect(printProposal(parsed as EditProposal)).toBe(text);
        // already-parsed values are accepted too
        expect(parseProposal(JSON.parse(text))).toEqual(p);
      }),
      RUNS,
    );
  });

  // Feature: trip-assistant-chat, Property 1: Proposal serialization round trip (invalid values)
  it("returns null for arbitrary junk JSON values", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(parseProposal(v)).toBeNull();
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(parseProposal(s)).toBeNull();
      }),
      RUNS,
    );
  });

  // Feature: trip-assistant-chat, Property 1: Proposal serialization round trip (mutations)
  it("returns null for wrong version, bad times and non-https price URLs", () => {
    const badTime = fc.oneof(
      fc.constantFrom("24:00", "12:60", "9:30", "1230", "ab:cd", "", "12:5", "23:59:00"),
      fc.string().filter((s) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(s)),
    );
    fc.assert(
      fc.property(
        proposalArb,
        fc.integer().filter((n) => n !== 1),
        badTime,
        fc.constantFrom("http://", "ftp://", "", "//"),
        (p, version, time, scheme) => {
          const base = JSON.parse(printProposal(p));
          expect(parseProposal({ ...base, version })).toBeNull();
          expect(parseProposal({ ...base, version: "1" })).toBeNull();
          expect(parseProposal({ ...base, edit: { ...base.edit, op: "retime", index: 0, expectTitle: "x", time } })).toBeNull();
          if (base.edit.op === "add" || base.edit.op === "move") {
            expect(parseProposal({ ...base, edit: { ...base.edit, time } })).toBeNull();
          }
          const price = { inr: 1, sourceUrl: `${scheme}example.com/x`, sourceHost: "example.com", checkedAt: "2024-01-01", basis: "b" };
          expect(parseProposal({ ...base, price })).toBeNull();
        },
      ),
      RUNS,
    );
  });
});

/* ----------------------------- Property 13 -------------------------- */
const itinerary = {
  title: "Trip",
  totalCost: 0,
  days: [{ day: 1, date: "2025-01-01", title: "D1", theme: "t", total: 0, activities: [] }],
};

describe("wire: request limits", () => {
  // Feature: trip-assistant-chat, Property 13: Request limits
  // Validates: Requirements 4.10, 4.11, 13.4, 14.5
  it("accepts a message iff its trimmed length is 1..1000", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 1200 }),
          fc.string({ minLength: 990, maxLength: 1010 }),
          fc.tuple(fc.constantFrom("", " ", "\n\t "), fc.string({ maxLength: 1100 }), fc.constantFrom("", " ", "\n")).map((t) => t.join("")),
        ),
        (message) => {
          const len = message.trim().length;
          const r = parseRequest({ message, itinerary });
          expect(r.ok).toBe(len >= 1 && len <= MAX_MESSAGE_CHARS);
          if (r.ok) expect(r.value.message).toBe(message.trim());
        },
      ),
      RUNS,
    );
  });

  it("handles exact message boundaries", () => {
    expect(parseRequest({ message: "a".repeat(1000), itinerary }).ok).toBe(true);
    expect(parseRequest({ message: "a".repeat(1001), itinerary }).ok).toBe(false);
    expect(parseRequest({ message: `  ${"a".repeat(1000)}  `, itinerary }).ok).toBe(true);
    expect(parseRequest({ message: "   ", itinerary }).ok).toBe(false);
  });

  // Feature: trip-assistant-chat, Property 13: Request limits (history)
  it("trimHistory keeps the last min(length, 10) turns in order", () => {
    const turn = fc.record({ role: fc.constantFrom("user" as const, "assistant" as const), text: fc.string({ minLength: 1, maxLength: 20 }) });
    fc.assert(
      fc.property(fc.array(turn, { maxLength: 40 }), (history: ChatTurn[]) => {
        const copy = history.slice();
        const out = trimHistory(history);
        expect(out).toEqual(history.slice(Math.max(0, history.length - MAX_HISTORY_TURNS)));
        expect(out.length).toBe(Math.min(history.length, MAX_HISTORY_TURNS));
        expect(history).toEqual(copy);
      }),
      RUNS,
    );
  });

  it("parseRequest trims the history to the last 10 turns", () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `t${i}` }));
    const r = parseRequest({ message: "hi", itinerary, history });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.history.map((h) => h.text)).toEqual(history.slice(-10).map((h) => h.text));
  });

  // Feature: trip-assistant-chat, Property 13: Request limits (body size)
  it("rejects bodies over 262,144 bytes and counts multibyte chars as bytes", () => {
    expect(MAX_BODY_BYTES).toBe(262144);
    expect(withinByteLimit("a".repeat(262144))).toBe(true);
    expect(withinByteLimit("a".repeat(262145))).toBe(false);
    // 87,382 three-byte chars = 262,146 bytes, yet far fewer than 262,144 chars
    const euro = "€".repeat(87382);
    expect(euro.length).toBeLessThan(MAX_BODY_BYTES);
    expect(utf8ByteLength(euro)).toBe(262146);
    expect(withinByteLimit(euro)).toBe(false);
    expect(withinByteLimit("€".repeat(87381))).toBe(true);
    expect(utf8ByteLength("😀")).toBe(4);

    const big = JSON.stringify({ message: "hi", itinerary, pad: "€".repeat(87382) });
    const r = parseRequestText(big);
    expect(r.ok).toBe(false);
    const ok = parseRequestText(JSON.stringify({ message: "hi", itinerary }));
    expect(ok.ok).toBe(true);
  });

  it("utf8ByteLength matches Buffer.byteLength", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (s) => {
        expect(utf8ByteLength(s)).toBe(new TextEncoder().encode(s).length);
      }),
      RUNS,
    );
  });

  // Feature: trip-assistant-chat, Property 13: Request limits (malformed bodies)
  it("returns an error and never throws for malformed bodies", () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const r = parseRequest(v);
        expect(r.ok).toBe(false);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (s) => {
        expect(() => parseRequestText(s)).not.toThrow();
        const r = parseRequestText(s);
        expect(typeof r.ok).toBe("boolean");
      }),
      RUNS,
    );
    for (const bad of ["", "{", "null", "[]", "42", '"x"', "{}", '{"message":"hi"}', '{"message":"hi","itinerary":{"days":[]}}']) {
      expect(parseRequestText(bad).ok).toBe(false);
    }
    expect(parseRequest(undefined).ok).toBe(false);
    expect(parseRequest({ message: 5, itinerary }).ok).toBe(false);
  });
});
