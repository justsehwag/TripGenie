/**
 * Flights page list rules (trip-planning-v2 Req 11-13).
 *
 * Pure module: no network, no framework, no server-only imports.
 */

import type { FlightAvailability } from "@/lib/flight-availability";

export type FlightSortKey = "cheapest" | "fastest" | "earliest";
export const DEFAULT_FLIGHT_SORT: FlightSortKey = "cheapest";

/** Total. "recommended" and unknown input give "cheapest". */
export function parseFlightSort(raw: unknown): FlightSortKey {
  return raw === "fastest" || raw === "earliest" || raw === "cheapest" ? raw : DEFAULT_FLIGHT_SORT;
}

export interface SortableFlight {
  key: string;
  order: number;
  fare: number;
  durationMin: number;
  departKey: string;
}

function num(n: number): number {
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** Stable, returns a new array. Ties break on original position. */
export function sortFlightOptions<T extends SortableFlight>(items: readonly T[], sort: FlightSortKey): T[] {
  const indexed = items.map((item, i) => ({ item, i }));
  indexed.sort((a, b) => {
    let c = 0;
    if (sort === "fastest") {
      const x = num(a.item.durationMin);
      const y = num(b.item.durationMin);
      c = x === y ? 0 : x < y ? -1 : 1;
    } else if (sort === "earliest") {
      c = a.item.departKey < b.item.departKey ? -1 : a.item.departKey > b.item.departKey ? 1 : 0;
    } else {
      const x = num(a.item.fare);
      const y = num(b.item.fare);
      c = x === y ? 0 : x < y ? -1 : 1;
    }
    return c !== 0 ? c : a.i - b.i;
  });
  return indexed.map((e) => e.item);
}

/** Key of the lowest fare; first in given order on ties; null for empty. Independent of sort. */
export function cheapestKey(items: readonly SortableFlight[]): string | null {
  let best: SortableFlight | null = null;
  for (const it of items) {
    if (best === null || num(it.fare) < num(best.fare)) best = it;
  }
  return best === null ? null : best.key;
}

/** Same basis as fareFromProvider(total, adults).perPerson in lib/providers/serpapi-flights.ts. */
export function perPersonFromTotal(total: number, adults: number): number {
  return Math.round(total / adults);
}

function priced(p: number | null): p is number {
  return typeof p === "number" && Number.isFinite(p);
}

/** Ascending by price, unpriced last, ties keep provider order. New array. */
export function sortVendorPrices<T extends { price: number | null }>(options: readonly T[]): T[] {
  const indexed = options.map((o, i) => ({ o, i }));
  indexed.sort((a, b) => {
    const pa = priced(a.o.price);
    const pb = priced(b.o.price);
    if (pa && pb) {
      const d = (a.o.price as number) - (b.o.price as number);
      return d !== 0 ? d : a.i - b.i;
    }
    if (pa) return -1;
    if (pb) return 1;
    return a.i - b.i;
  });
  return indexed.map((e) => e.o);
}

/** Index of the lowest-priced option (first on ties), or -1 when none is priced. */
export function lowestVendorIndex(options: readonly { price: number | null }[]): number {
  let idx = -1;
  for (let i = 0; i < options.length; i++) {
    const p = options[i].price;
    if (!priced(p)) continue;
    if (idx === -1 || p < (options[idx].price as number)) idx = i;
  }
  return idx;
}

export function stopsLabel(stops: number): string {
  if (!Number.isFinite(stops) || stops <= 0) return "Non-stop";
  return stops === 1 ? "1 stop" : `${stops} stops`;
}

export type FlightsViewKind = "ground-note" | "no-flights" | "list" | "notice-only";

/** "list" only when availability is "available", status is "live" and flightCount > 0. */
export function decideFlightsView(i: {
  availability: FlightAvailability;
  status: string;
  flightCount: number;
}): FlightsViewKind {
  if (i.availability === "no-airport") return "ground-note";
  if (i.availability === "no-flights") return "no-flights";
  return i.status === "live" && i.flightCount > 0 ? "list" : "notice-only";
}
