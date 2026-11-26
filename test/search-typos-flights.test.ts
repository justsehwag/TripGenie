// Feature: search-typos-flights. Properties 1-8 plus example checks.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  damerauLevenshtein,
  didYouMean,
  fuzzyMatch,
  maxDistanceFor,
  normalizePlace,
  type FuzzyCandidate,
} from "@/lib/fuzzy-match";
import { suggestReducer, type SuggestNavKey, type SuggestNavState } from "@/lib/suggest-nav";
import { AIRPORTS, resolveAirport } from "@/lib/airports";
import {
  COUNTRY_AIRPORTS,
  airportCandidates,
  resolveDestination,
} from "@/lib/destination-airports";
import { mergeByAirport, type AirportSearch } from "@/lib/flight-groups";
import { PlaceSuggestInput } from "@/components/place-suggest-input";

const RUNS = { numRuns: 150 };
const ROOT = join(__dirname, "..");
const letters = "abcdefghijklmnopqrstuvwxyz".split("");
const letter = fc.constantFrom(...letters);
const word = (min: number, max: number) =>
  fc.array(letter, { minLength: min, maxLength: max }).map((a) => a.join(""));

/** One edit (insert, delete, substitute, adjacent transpose) on a letters-only string. */
function applyEdit(s: string, kind: number, pos: number, ch: string): string {
  const i = pos % Math.max(1, s.length);
  switch (kind % 4) {
    case 0:
      return s.slice(0, i) + ch + s.slice(i);
    case 1:
      return s.slice(0, i) + s.slice(i + 1);
    case 2:
      return s.slice(0, i) + ch + s.slice(i + 1);
    default:
      return i + 1 < s.length ? s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2) : s;
  }
}
const edit = fc.record({ kind: fc.nat(3), pos: fc.nat(60), ch: letter });

const CANDIDATES = airportCandidates();
const lettersOnly = (s: string) => normalizePlace(s).replace(/[^a-z]/g, "");

describe("Property 1: distance is a symmetric metric with transposition cost 1", () => {
  it("Feature: search-typos-flights, Property 1", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 }), (a, b) => {
        expect(damerauLevenshtein(a, b)).toBe(damerauLevenshtein(b, a));
        expect(damerauLevenshtein(a, b) === 0).toBe(normalizePlace(a) === normalizePlace(b));
      }),
      RUNS,
    );
  });
  it("Feature: search-typos-flights, Property 1 (transposition)", () => {
    fc.assert(
      fc.property(word(2, 12), fc.nat(40), (s, p) => {
        const idx = [...s].map((_, i) => i).filter((i) => i + 1 < s.length && s[i] !== s[i + 1]);
        fc.pre(idx.length > 0);
        const i = idx[p % idx.length];
        const swapped = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
        expect(damerauLevenshtein(s, swapped)).toBe(1);
      }),
      RUNS,
    );
  });
});

describe("Property 2: matches stay within the threshold and are ordered", () => {
  it("Feature: search-typos-flights, Property 2", () => {
    const cands: FuzzyCandidate[] = [...CANDIDATES];
    const query = fc.oneof(
      word(1, 10),
      fc
        .tuple(fc.constantFrom(...cands), edit)
        .map(([c, e]) => applyEdit(lettersOnly(c.label), e.kind, e.pos, e.ch)),
    );
    fc.assert(
      fc.property(query, (q) => {
        const hits = fuzzyMatch(q, cands, cands.length);
        const nq = normalizePlace(q);
        for (const h of hits) {
          expect(h.distance <= maxDistanceFor(nq.length) || (h.prefix && h.distance === 0)).toBe(true);
          if (nq.length < 4) expect(h.distance).toBe(0);
        }
        for (let i = 1; i < hits.length; i++) {
          const p = hits[i - 1];
          const c = hits[i];
          expect(p.distance <= c.distance).toBe(true);
          if (p.distance === c.distance) expect(Number(p.prefix) >= Number(c.prefix)).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

describe("Property 3: one edit of a known name still finds it", () => {
  it("Feature: search-typos-flights, Property 3", () => {
    const forms: { id: string; form: string }[] = [];
    for (const c of CANDIDATES) {
      for (const f of [c.label, ...(c.aliases ?? [])]) {
        const s = lettersOnly(f);
        if (s.length >= 5 && s === normalizePlace(f)) forms.push({ id: c.id, form: s });
      }
    }
    expect(forms.length).toBeGreaterThan(20);
    fc.assert(
      fc.property(fc.constantFrom(...forms), edit, ({ id, form }, e) => {
        const typo = applyEdit(form, e.kind, e.pos, e.ch);
        const ids = fuzzyMatch(typo, CANDIDATES, CANDIDATES.length).map((h) => h.id);
        expect(ids).toContain(id);
      }),
      RUNS,
    );
  });
});

describe("Property 4: existing airport resolution is preserved", () => {
  it("Feature: search-typos-flights, Property 4", () => {
    const countryAliases = new Set(COUNTRY_AIRPORTS.flatMap((c) => c.aliases.map(normalizePlace)));
    const inputs: string[] = [];
    for (const a of AIRPORTS) {
      inputs.push(a.code, a.code.toLowerCase());
      for (const n of a.names) inputs.push(n, n.toUpperCase());
    }
    const usable = inputs.filter((s) => !countryAliases.has(normalizePlace(s)) && resolveAirport(s));
    expect(usable.length).toBeGreaterThan(50);
    fc.assert(
      fc.property(fc.constantFrom(...usable), (s) => {
        const r = resolveDestination(s);
        expect(r.kind).toBe("airport");
        if (r.kind === "airport") expect(r.code).toBe(resolveAirport(s));
      }),
      RUNS,
    );
  });
});

describe("Property 5: country text resolves to its table airports", () => {
  it("Feature: search-typos-flights, Property 5", () => {
    const pairs = COUNTRY_AIRPORTS.flatMap((c) =>
      c.aliases.filter((a) => a.replace(/\s/g, "").length >= 5).map((a) => ({ c, alias: a })),
    );
    let checked = 0;
    fc.assert(
      fc.property(fc.constantFrom(...pairs), edit, ({ c, alias }, e) => {
        const typo = applyEdit(alias, e.kind, e.pos, e.ch);
        const hits = fuzzyMatch(typo, CANDIDATES, CANDIDATES.length);
        const unique = hits.length > 0 && hits.filter((h) => h.distance === hits[0].distance).length === 1;
        fc.pre(unique && hits[0].id === `country:${c.country}` && !resolveAirport(typo));
        checked++;
        const r = resolveDestination(typo);
        expect(r.kind).toBe("country");
        if (r.kind === "country") {
          expect(r.airports).toEqual(c.airports);
          expect(r.airports.length).toBeGreaterThanOrEqual(1);
          expect(r.airports.length).toBeLessThanOrEqual(4);
          for (const a of r.airports) expect(a.code).toMatch(/^[A-Z]{3}$/);
        }
      }),
      { ...RUNS, maxSkipsPerRun: 2000 },
    );
    expect(checked).toBeGreaterThan(20);
  });
  it("every table entry has 1 to 4 uppercase 3-letter codes", () => {
    for (const c of COUNTRY_AIRPORTS) {
      expect(c.airports.length).toBeGreaterThanOrEqual(1);
      expect(c.airports.length).toBeLessThanOrEqual(4);
      for (const a of c.airports) expect(a.code).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe("Property 6: ties never auto-correct", () => {
  it("Feature: search-typos-flights, Property 6", () => {
    const labels = CANDIDATES.map((c) => lettersOnly(c.label)).filter((s) => s.length >= 4);
    const query = fc.oneof(
      word(4, 8),
      fc.tuple(fc.constantFrom(...labels), fc.integer({ min: 4, max: 6 })).map(([l, n]) => l.slice(0, n)),
      fc
        .tuple(fc.constantFrom(...labels), edit)
        .map(([l, e]) => applyEdit(l, e.kind, e.pos, e.ch)),
    );
    let ties = 0;
    fc.assert(
      fc.property(query, (q) => {
        const hits = fuzzyMatch(q, CANDIDATES, 8);
        fc.pre(hits.length > 0 && hits.filter((h) => h.distance === hits[0].distance).length >= 2);
        fc.pre(!resolveAirport(q));
        const nq = normalizePlace(q);
        fc.pre(!COUNTRY_AIRPORTS.some((c) => c.aliases.some((a) => normalizePlace(a) === nq)));
        ties++;
        const r = resolveDestination(q);
        expect(r.kind).toBe("unresolved");
        if (r.kind === "unresolved") expect(r.suggestions.length).toBeGreaterThanOrEqual(2);
      }),
      { ...RUNS, maxSkipsPerRun: 5000 },
    );
    expect(ties).toBeGreaterThan(0);
  });
});

describe("Property 7: merge groups every flight once", () => {
  const status = fc.constantFrom("live", "live", "live", "unconfigured", "invalid", "unavailable");
  const search = fc.record({
    code: fc.constantFrom("CMB", "JAF", "HRI", "BKK"),
    status,
    tokens: fc.array(fc.constantFrom("a", "b", "c", "d", "e", "f"), { maxLength: 5 }),
  });
  it("Feature: search-typos-flights, Property 7", () => {
    fc.assert(
      fc.property(fc.array(search, { maxLength: 4 }), (raw) => {
        const searches = raw.map(
          (r) =>
            ({
              code: r.code,
              city: `City ${r.code}`,
              name: `Airport ${r.code}`,
              status: r.status,
              flights: r.tokens.map((t) => ({ token: t })),
            }) as unknown as AirportSearch,
        );
        const m = mergeByAirport(searches);
        const all = m.groups.flatMap((g) => g.flights.map((f) => f.token));
        expect(new Set(all).size).toBe(all.length);
        const liveTokens = new Set(raw.filter((r) => r.status === "live").flatMap((r) => r.tokens));
        expect(m.total).toBe(liveTokens.size);
        expect(all.length).toBe(m.total);
        expect(m.failed.length).toBe(raw.filter((r) => r.status !== "live").length);
        // group order follows input order
        let from = 0;
        for (const g of m.groups) {
          const at = searches.findIndex((s, i) => i >= from && s.code === g.code && s.status === "live");
          expect(at).toBeGreaterThanOrEqual(from);
          from = at + 1;
        }
        // live searches yield exactly one group or one empty entry
        expect(m.groups.length + m.empty.length).toBe(raw.filter((r) => r.status === "live").length);
        for (const g of m.groups) expect(g.flights.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });
});

describe("Property 8: suggestion navigation stays in bounds and never edits text", () => {
  const key = fc.constantFrom<SuggestNavKey>("ArrowDown", "ArrowUp", "Home", "End", "Escape");
  it("Feature: search-typos-flights, Property 8", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 10 }), fc.nat(8), fc.array(key, { maxLength: 30 }), (text, length, keys) => {
        let s: SuggestNavState = { text, active: -1, open: true };
        for (const k of keys) {
          s = suggestReducer(s, { type: "key", key: k, length });
          expect(s.text).toBe(text);
          expect(s.active).toBeGreaterThanOrEqual(-1);
          expect(s.active).toBeLessThanOrEqual(length - 1);
        }
        const accepted = suggestReducer(s, { type: "accept", value: "Goa" });
        expect(accepted.text).toBe("Goa");
        expect(accepted.open).toBe(false);
      }),
      RUNS,
    );
  });
});

describe("examples", () => {
  it("Sri Lanka resolves to CMB, JAF, HRI", () => {
    const r = resolveDestination("Sri Lanka");
    expect(r.kind).toBe("country");
    if (r.kind === "country") expect(r.airports.map((a) => a.code)).toEqual(["CMB", "JAF", "HRI"]);
  });

  it('"srilanks" is corrected to Sri Lanka', () => {
    const r = resolveDestination("srilanks");
    expect(r.kind).toBe("country");
    if (r.kind === "country") {
      expect(r.country).toBe("Sri Lanka");
      expect(r.corrected).toBeTruthy();
      expect(r.typed).toBe("srilanks");
    }
  });

  it('"chenai" is corrected to Chennai (MAA)', () => {
    const r = resolveDestination("chenai");
    expect(r.kind).toBe("airport");
    if (r.kind === "airport") {
      expect(r.code).toBe("MAA");
      expect(r.corrected).toBeTruthy();
    }
  });

  it("didYouMean returns null for an exact name", () => {
    expect(didYouMean("Chennai", CANDIDATES)).toBeNull();
  });

  it("PlaceSuggestInput renders combobox, listbox and at most 6 options when open", () => {
    const html = renderToStaticMarkup(
      createElement(PlaceSuggestInput, {
        id: "t-place",
        name: "destination",
        label: "To",
        value: "colo",
        onChange: () => {},
        candidates: CANDIDATES,
        initialOpen: true,
        ariaInvalid: true,
      }),
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="t-place-list"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-invalid="true"');
    const options = html.match(/role="option"/g) ?? [];
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options.length).toBeLessThanOrEqual(6);
  });

  it("the Flights page and group list carry no coupon strip, and its component is gone", () => {
    const page = readFileSync(join(ROOT, "app", "flights", "page.tsx"), "utf8");
    const list = readFileSync(join(ROOT, "components", "flight-groups-list.tsx"), "utf8");
    for (const src of [page, list]) {
      expect(src).not.toMatch(/FlightCoupons|flight-coupons/);
      expect(src).not.toContain("Unlock a lower");
    }
    expect(existsSync(join(ROOT, "components", "flight-coupons.tsx"))).toBe(false);
  });
});
