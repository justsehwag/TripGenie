import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveAirport } from "@/lib/airports";
import {
  decideLiveFaresFetch,
  isCurrentLiveKey,
  resolvablePlace,
  type LiveFaresInput,
} from "@/lib/live-fares-trigger";

const base: LiveFaresInput = {
  origin: "Chennai",
  destination: "Dubai",
  checkIn: "2030-03-10",
  checkOut: "2030-03-15",
  travellers: 2,
};

const NUM_RUNS = 100;

const isoDate = fc
  .integer({ min: 0, max: 3000 })
  .map((d) => new Date(Date.UTC(2030, 0, 1) + d * 86400000).toISOString().slice(0, 10));

describe("decideLiveFaresFetch", () => {
  it("fetches with a key for a complete input", () => {
    const d = decideLiveFaresFetch(base);
    expect(d.kind).toBe("fetch");
    if (d.kind === "fetch") {
      expect(d.checkIn).toBe("2030-03-10");
      expect(d.checkOut).toBe("2030-03-15");
      expect(d.travellers).toBe(2);
      expect(d.key).toBe("Chennai|Dubai|2030-03-10|2030-03-15|2");
    }
  });

  it("waits when destination is blank", () => {
    expect(decideLiveFaresFetch({ ...base, destination: "  " }).kind).toBe("wait");
  });

  it("waits on missing or malformed dates", () => {
    expect(decideLiveFaresFetch({ ...base, checkIn: "" }).kind).toBe("wait");
    expect(decideLiveFaresFetch({ ...base, checkOut: "" }).kind).toBe("wait");
    expect(decideLiveFaresFetch({ ...base, checkIn: "10/03/2030" }).kind).toBe("wait");
  });

  it("waits when checkOut is not after checkIn", () => {
    expect(decideLiveFaresFetch({ ...base, checkOut: base.checkIn }).kind).toBe("wait");
    expect(decideLiveFaresFetch({ ...base, checkOut: "2030-03-01" }).kind).toBe("wait");
  });

  it("falls back checkIn<-departDate and checkOut<-returnDate", () => {
    const d = decideLiveFaresFetch({
      ...base,
      checkIn: "",
      checkOut: "",
      departDate: "2030-04-01",
      returnDate: "2030-04-06",
    });
    expect(d.kind).toBe("fetch");
    if (d.kind === "fetch") {
      expect(d.checkIn).toBe("2030-04-01");
      expect(d.checkOut).toBe("2030-04-06");
    }
  });

  it("prefers checkIn/checkOut over the fallbacks", () => {
    const d = decideLiveFaresFetch({ ...base, departDate: "2031-01-01", returnDate: "2031-01-09" });
    expect(d.kind === "fetch" && d.checkIn === base.checkIn && d.checkOut === base.checkOut).toBe(true);
  });

  it("clamps travellers to an integer >= 1", () => {
    const t = (n: number) => {
      const d = decideLiveFaresFetch({ ...base, travellers: n });
      return d.kind === "fetch" ? d.travellers : -1;
    };
    expect(t(0)).toBe(1);
    expect(t(-5)).toBe(1);
    expect(t(NaN)).toBe(1);
    expect(t(Infinity)).toBe(1);
    expect(t(3.9)).toBe(3);
  });

  it("property: travellers is always an integer >= 1", () => {
    fc.assert(
      fc.property(fc.oneof(fc.double({ noNaN: false }), fc.integer({ min: -100, max: 100 })), (n) => {
        const d = decideLiveFaresFetch({ ...base, travellers: n });
        expect(d.kind).toBe("fetch");
        if (d.kind === "fetch") {
          expect(Number.isInteger(d.travellers)).toBe(true);
          expect(d.travellers).toBeGreaterThanOrEqual(1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("property: identical input gives an identical key", () => {
    fc.assert(
      fc.property(isoDate, fc.integer({ min: 1, max: 3000 }), fc.integer({ min: 1, max: 9 }), (a, gap, n) => {
        const out = new Date(Date.parse(a) + gap * 86400000).toISOString().slice(0, 10);
        const input = { ...base, checkIn: a, checkOut: out, travellers: n };
        const d1 = decideLiveFaresFetch({ ...input });
        const d2 = decideLiveFaresFetch({ ...input });
        expect(d1.kind).toBe("fetch");
        expect(d1).toEqual(d2);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("property: changing any key field changes the key", () => {
    fc.assert(
      fc.property(
        isoDate,
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 9 }),
        fc.constantFrom("origin", "destination", "checkIn", "checkOut", "travellers"),
        (a, gap, n, field) => {
          const out = new Date(Date.parse(a) + gap * 86400000).toISOString().slice(0, 10);
          const input: LiveFaresInput = { ...base, checkIn: a, checkOut: out, travellers: n };
          const changed: LiveFaresInput = { ...input };
          switch (field) {
            case "origin": changed.origin = "Mumbai"; break;
            case "destination": changed.destination = "London"; break;
            case "checkIn":
              changed.checkIn = new Date(Date.parse(a) - 86400000).toISOString().slice(0, 10);
              break;
            case "checkOut":
              changed.checkOut = new Date(Date.parse(out) + 86400000).toISOString().slice(0, 10);
              break;
            case "travellers": changed.travellers = n + 1; break;
          }
          const k1 = decideLiveFaresFetch(input);
          const k2 = decideLiveFaresFetch(changed);
          expect(k1.kind).toBe("fetch");
          expect(k2.kind).toBe("fetch");
          if (k1.kind === "fetch" && k2.kind === "fetch") expect(k1.key).not.toBe(k2.key);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("resolvablePlace", () => {
  it('maps "Chennai, India" to a value resolveAirport resolves', () => {
    const v = resolvablePlace("Chennai, India");
    expect(v).toBeTruthy();
    expect(resolveAirport(v)).not.toBeNull();
  });

  it("returns empty for blank / non-string input and never invents", () => {
    expect(resolvablePlace("")).toBe("");
    expect(resolvablePlace(undefined)).toBe("");
    expect(resolvablePlace("Zzzzville, Nowhere")).toBe("Zzzzville, Nowhere");
  });
});

describe("isCurrentLiveKey", () => {
  it("is true only for equal keys", () => {
    expect(isCurrentLiveKey("a|b", "a|b")).toBe(true);
    expect(isCurrentLiveKey("a|b", "a|c")).toBe(false);
  });
});

describe("regression: re-run with same key before response (old bug)", () => {
  /** Models the planner effect using only the exported helpers. */
  function makeEffect() {
    let currentKey = "";
    let applied: string[] = [];
    let fetches = 0;
    const pending: { key: string }[] = [];
    return {
      run(input: LiveFaresInput) {
        const d = decideLiveFaresFetch(input);
        if (d.kind === "wait") return;
        currentKey = d.key;
        // Dedupe on the same key while a request is in flight.
        if (pending.some((p) => p.key === d.key)) return;
        fetches++;
        pending.push({ key: d.key });
      },
      respond(key: string) {
        // Old bug: cleanup cancelled this on any rerun. Fixed: only discard if key changed.
        if (isCurrentLiveKey(currentKey, key)) applied.push(key);
      },
      get applied() { return applied; },
      get fetches() { return fetches; },
    };
  }

  it("applies the response after a same-key rerun", () => {
    const e = makeEffect();
    e.run(base);
    e.run({ ...base }); // state changed (e.g. activity pricing), same key
    const d = decideLiveFaresFetch(base);
    if (d.kind !== "fetch") throw new Error("expected fetch");
    e.respond(d.key);
    expect(e.fetches).toBe(1);
    expect(e.applied).toEqual([d.key]);
  });

  it("discards the response when the key changed meanwhile", () => {
    const e = makeEffect();
    e.run(base);
    const first = decideLiveFaresFetch(base);
    e.run({ ...base, destination: "London" });
    if (first.kind !== "fetch") throw new Error("expected fetch");
    e.respond(first.key);
    expect(e.applied).toEqual([]);
  });
});
