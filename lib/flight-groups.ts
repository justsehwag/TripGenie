/**
 * Pure merge of per-airport flight searches into city groups.
 *
 * A country destination (for example Sri Lanka) is searched once per airport.
 * This module groups the results by airport in input order, drops a flight
 * token that already appeared in an earlier group, and reports airports that
 * returned nothing or failed. Type-only imports keep it free of server code.
 */
import type { LiveFlight, LiveStatus } from "@/lib/providers/serpapi-flights";

export interface AirportSearch {
  code: string;
  city: string;
  name: string;
  status: LiveStatus;
  flights: LiveFlight[];
  error?: string;
}

export interface FlightGroup {
  code: string;
  city: string;
  name: string;
  flights: LiveFlight[];
}

export interface AirportRef {
  code: string;
  city: string;
}

export interface MergedFlights {
  groups: FlightGroup[];
  /** Live searches that returned no flights (or only duplicates). */
  empty: AirportRef[];
  /** Searches whose status is not "live". */
  failed: AirportRef[];
  /** Number of flights across all groups. */
  total: number;
}

export function mergeByAirport(searches: readonly AirportSearch[]): MergedFlights {
  const seen = new Set<string>();
  const groups: FlightGroup[] = [];
  const empty: AirportRef[] = [];
  const failed: AirportRef[] = [];
  let total = 0;

  for (const s of searches) {
    const ref = { code: s.code, city: s.city };
    if (s.status !== "live") {
      failed.push(ref);
      continue;
    }
    const flights: LiveFlight[] = [];
    for (const f of s.flights) {
      if (seen.has(f.token)) continue;
      seen.add(f.token);
      flights.push(f);
    }
    if (flights.length === 0) {
      empty.push(ref);
      continue;
    }
    total += flights.length;
    groups.push({ code: s.code, city: s.city, name: s.name, flights });
  }

  return { groups, empty, failed, total };
}
