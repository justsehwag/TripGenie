/**
 * Destination resolution for flight search (search-typos-flights Req 4).
 *
 * Pure module. Turns free text, including typos, into one airport, a country
 * expanded to a few airports, or an unresolved result with suggestions.
 * Wraps `resolveAirport` from lib/airports.ts without changing it.
 *
 * COUNTRY_AIRPORTS is a curated static list, not provider data. Codes are
 * IATA codes of major international airports, taken from IATA airport listings
 * and the airport operators' public pages. Last reviewed: 2025-06.
 * Re-check a code before adding a new one. At most 4 airports per country.
 * If the flight provider has no fares for an airport, the page says so.
 */

import { AIRPORTS, resolveAirport } from "./airports";
import { fuzzyMatch, normalizePlace, type FuzzyCandidate } from "./fuzzy-match";

export interface CountryAirport {
  code: string;
  city: string;
  name: string;
}

export interface CountryAirports {
  country: string;
  /** Lower-case names the country is known by. */
  aliases: string[];
  airports: CountryAirport[];
}

export const COUNTRY_AIRPORTS: readonly CountryAirports[] = [
  {
    country: "Sri Lanka",
    aliases: ["sri lanka", "srilanka", "ceylon"],
    airports: [
      { code: "CMB", city: "Colombo", name: "Bandaranaike International" },
      { code: "JAF", city: "Jaffna", name: "Jaffna International" },
      { code: "HRI", city: "Hambantota", name: "Mattala Rajapaksa International" },
    ],
  },
  {
    country: "Thailand",
    aliases: ["thailand", "siam"],
    airports: [
      { code: "BKK", city: "Bangkok", name: "Suvarnabhumi" },
      { code: "DMK", city: "Bangkok", name: "Don Mueang International" },
      { code: "HKT", city: "Phuket", name: "Phuket International" },
      { code: "CNX", city: "Chiang Mai", name: "Chiang Mai International" },
    ],
  },
  {
    country: "United Arab Emirates",
    aliases: ["united arab emirates", "uae", "emirates"],
    airports: [
      { code: "DXB", city: "Dubai", name: "Dubai International" },
      { code: "AUH", city: "Abu Dhabi", name: "Zayed International" },
      { code: "SHJ", city: "Sharjah", name: "Sharjah International" },
    ],
  },
  {
    country: "Malaysia",
    aliases: ["malaysia"],
    airports: [
      { code: "KUL", city: "Kuala Lumpur", name: "Kuala Lumpur International" },
      { code: "PEN", city: "Penang", name: "Penang International" },
      { code: "LGK", city: "Langkawi", name: "Langkawi International" },
    ],
  },
  {
    country: "Indonesia",
    aliases: ["indonesia"],
    airports: [
      { code: "DPS", city: "Bali", name: "Ngurah Rai International" },
      { code: "CGK", city: "Jakarta", name: "Soekarno-Hatta International" },
    ],
  },
  {
    country: "Singapore",
    aliases: ["singapore"],
    airports: [{ code: "SIN", city: "Singapore", name: "Changi" }],
  },
  {
    country: "Maldives",
    aliases: ["maldives"],
    airports: [{ code: "MLE", city: "Male", name: "Velana International" }],
  },
  {
    country: "Nepal",
    aliases: ["nepal"],
    airports: [{ code: "KTM", city: "Kathmandu", name: "Tribhuvan International" }],
  },
  {
    country: "Vietnam",
    aliases: ["vietnam", "viet nam"],
    airports: [
      { code: "SGN", city: "Ho Chi Minh City", name: "Tan Son Nhat International" },
      { code: "HAN", city: "Hanoi", name: "Noi Bai International" },
      { code: "DAD", city: "Da Nang", name: "Da Nang International" },
    ],
  },
  {
    country: "Japan",
    aliases: ["japan"],
    airports: [
      { code: "HND", city: "Tokyo", name: "Haneda" },
      { code: "NRT", city: "Tokyo", name: "Narita International" },
      { code: "KIX", city: "Osaka", name: "Kansai International" },
    ],
  },
  {
    country: "Australia",
    aliases: ["australia"],
    airports: [
      { code: "SYD", city: "Sydney", name: "Kingsford Smith" },
      { code: "MEL", city: "Melbourne", name: "Melbourne Airport" },
      { code: "BNE", city: "Brisbane", name: "Brisbane Airport" },
    ],
  },
];

export type ResolvedDestination =
  | { kind: "airport"; code: string; typed: string; corrected?: { label: string } }
  | {
      kind: "country";
      country: string;
      airports: CountryAirports["airports"];
      typed: string;
      corrected?: { label: string };
    }
  | { kind: "unresolved"; typed: string; suggestions: { label: string }[] };

const COUNTRY_ALIAS_SET: ReadonlySet<string> = new Set(
  COUNTRY_AIRPORTS.flatMap((c) => c.aliases.map(normalizePlace)),
);

const AIRPORT_NAME_SET: ReadonlySet<string> = new Set(
  AIRPORTS.flatMap((a) => a.names.map(normalizePlace)),
);
const AIRPORT_CODE_SET: ReadonlySet<string> = new Set(AIRPORTS.map((a) => a.code));

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/** Fuzzy candidates: airports (ids "airport:CODE") and countries (ids "country:Name"). */
export function airportCandidates(): FuzzyCandidate[] {
  const out: FuzzyCandidate[] = [];
  for (const a of AIRPORTS) {
    // Country aliases on an airport row belong to the country candidate.
    const names = a.names.filter((n) => !COUNTRY_ALIAS_SET.has(normalizePlace(n)));
    if (names.length === 0) continue;
    out.push({
      id: `airport:${a.code}`,
      label: titleCase(names[0]),
      aliases: names.slice(1).map(titleCase),
    });
  }
  for (const c of COUNTRY_AIRPORTS) {
    out.push({ id: `country:${c.country}`, label: c.country, aliases: c.aliases.map(titleCase) });
  }
  return out;
}

function countryResult(
  c: CountryAirports,
  typed: string,
  corrected?: { label: string },
): ResolvedDestination {
  const base = { kind: "country" as const, country: c.country, airports: c.airports.slice(0, 4), typed };
  return corrected ? { ...base, corrected } : base;
}

/** True when `resolveAirport` would answer only through its bare 3-letter rule. */
function isBareCodeFallback(input: string): boolean {
  const key = normalizePlace(input);
  if (!/^[a-z]{3}$/.test(key) || /\(\s*[a-z]{3}\s*\)\s*$/i.test(input)) return false;
  return !AIRPORT_NAME_SET.has(key) && !AIRPORT_CODE_SET.has(key.toUpperCase());
}

export function resolveDestination(input: string): ResolvedDestination {
  const typed = typeof input === "string" ? input.trim() : "";
  const key = normalizePlace(typed);
  if (!key) return { kind: "unresolved", typed, suggestions: [] };

  // 1. Exact country alias.
  const exact = COUNTRY_AIRPORTS.find((c) => c.aliases.some((a) => normalizePlace(a) === key));
  if (exact) return countryResult(exact, typed);

  // 2. Existing resolution, except its bare 3-letter fallback.
  const known = resolveAirport(typed);
  if (known && !isBareCodeFallback(typed)) return { kind: "airport", code: known, typed };

  // 3. Fuzzy match over airports and countries; ties are never auto-corrected.
  const hits = fuzzyMatch(typed, airportCandidates(), 8);
  if (hits.length > 0) {
    const tied = hits.filter((h) => h.distance === hits[0].distance);
    if (tied.length === 1) {
      const hit = tied[0];
      const corrected = { label: hit.label };
      if (hit.id.startsWith("country:")) {
        const c = COUNTRY_AIRPORTS.find((x) => `country:${x.country}` === hit.id);
        if (c) return countryResult(c, typed, corrected);
      } else {
        return { kind: "airport", code: hit.id.slice("airport:".length), typed, corrected };
      }
    }
  }

  // 4. Bare 3-letter code, as before.
  if (known) return { kind: "airport", code: known, typed };

  // 5. Unresolved; offer the closest labels (all of them on a tie).
  const top = hits.length > 0 ? hits.filter((h) => h.distance === hits[0].distance) : [];
  const pool = top.length > 1 ? top : hits;
  return {
    kind: "unresolved",
    typed,
    suggestions: pool.slice(0, 5).map((h) => ({ label: h.label })),
  };
}
