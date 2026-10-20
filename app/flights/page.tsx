import type { Metadata } from "next";
import Link from "next/link";
import { parseCriteria, serializeCriteria, type FlightsCriteria } from "@/lib/search-criteria";
import { runSearch } from "@/lib/search";
import type { FlightOffer } from "@/lib/types";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import {
  FlightOfferCard,
  flightDurationMinutes,
} from "@/components/flight-offer-card";

export const metadata: Metadata = { title: "Flights - TripGenie" };

/**
 * Flights Results_Page (server component) — design "Booking Site ▸ Results_Page".
 *
 * Reads `searchParams`, parses them into typed `FlightsCriteria` via
 * `parseCriteria("flights", …)` so opening or refreshing the URL reproduces the
 * identical search (Req 24.6 / 28.1), requests the flight offer set from the
 * Search_API (`runSearch`, Req 24.7), and renders a results summary, a sort
 * control offering price / duration / departure-time ordering (Req 24.8),
 * filter controls, and a `FlightOffer` card per result. Each card shows the
 * FlightOffer fields, the fare per person and the fare × travellers from the
 * Pricing Engine, and the OfferMeta provenance label; estimated offers show the
 * no-payment / no-ticket disclosure (Req 24.9 / 24.12). Cards link to
 * `/flights/[id]`.
 *
 * Requirements: 24.1, 24.6, 24.7, 24.8, 24.9, 24.10, 24.12, 28.1.
 */

type RawSearchParams = Record<string, string | string[] | undefined>;

type SortOption = "price" | "duration" | "departure";
const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "price", label: "Price (lowest first)" },
  { value: "duration", label: "Duration (shortest first)" },
  { value: "departure", label: "Departure time (earliest first)" },
];

/** Max-stops filter options; "any" means no filtering. */
const STOP_FILTERS: { value: string; label: string }[] = [
  { value: "any", label: "Any number of stops" },
  { value: "0", label: "Non-stop only" },
  { value: "1", label: "Up to 1 stop" },
];

/** Collapse Next's `string | string[]` param into the first string value. */
function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Normalise a raw `sort` param to a known SortOption (price is the default). */
function parseSort(raw: string | undefined): SortOption {
  return raw === "duration" || raw === "departure" ? raw : "price";
}

/** Rebuild the criteria query string from parsed criteria (round-trips the URL). */
function criteriaQuery(criteria: FlightsCriteria): string {
  return serializeCriteria(criteria);
}

/** Map parsed flight criteria to the Inventory_Adapter query shape. */
function toInventoryQuery(c: FlightsCriteria): InventoryQuery {
  return {
    origin: c.origin,
    destination: c.destination,
    cabin: c.cabin,
    // Flights do not use the stay fields; supply inert defaults.
    stayStyle: "Standard",
    nights: 1,
  };
}

/** Pure, stable sort of flight offers by the selected ordering (Req 24.8). */
function sortOffers(offers: FlightOffer[], sort: SortOption): FlightOffer[] {
  const copy = [...offers];
  copy.sort((a, b) => {
    switch (sort) {
      case "duration":
        return (
          flightDurationMinutes(a.depart, a.arrive) -
          flightDurationMinutes(b.depart, b.arrive)
        );
      case "departure":
        return a.depart.localeCompare(b.depart);
      case "price":
      default:
        return a.farePerPerson - b.farePerPerson;
    }
  });
  return copy;
}

/** Apply the max-stops filter; "any" leaves the set untouched. */
function filterOffers(offers: FlightOffer[], maxStops: string): FlightOffer[] {
  if (maxStops !== "0" && maxStops !== "1") return offers;
  const cap = Number.parseInt(maxStops, 10);
  return offers.filter((o) => o.stops <= cap);
}

export default async function FlightsResultsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;

  // Reproduce the search from the URL (Req 24.6 / 28.1). parseCriteria is total.
  const qs = serializeRaw(raw);
  const criteria = parseCriteria("flights", qs) as FlightsCriteria;

  const sort = parseSort(firstValue(raw.sort));
  const maxStops = firstValue(raw.maxStops) ?? "any";

  const result = runSearch(toInventoryQuery(criteria));
  const all = result.flights;
  const filtered = filterOffers(all, maxStops);
  const offers = sortOffers(filtered, sort);

  const routeLabel =
    criteria.origin && criteria.destination
      ? `${criteria.origin} → ${criteria.destination}`
      : criteria.destination || criteria.origin || "your trip";

  const query = criteriaQuery(criteria);

  // On a Search_API failure/timeout (Req 28.4 / 4.3) `runSearch` returns a
  // labelled error with the confirmed destination retained. Render the message
  // and a retry control that resubmits the SAME criteria (same URL).
  if (result.error) {
    return (
      <main className="shell results">
        <header className="results__head">
          <p className="eyebrow">Flights</p>
          <h1>We couldn&rsquo;t load flights for {routeLabel}</h1>
        </header>
        <section className="card results__error" role="alert">
          <p>{result.error}</p>
          <Link className="cta" href={`/flights${query ? `?${query}` : ""}`}>
            Retry search
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shell results">
      <header className="results__head">
        <p className="eyebrow">Flights</p>
        <h1>Flights for {routeLabel}</h1>
        <p className="results__summary" role="status">
          {offers.length} {offers.length === 1 ? "flight" : "flights"} ·{" "}
          {criteria.tripType === "round-trip" ? "Round-trip" : "One-way"} ·{" "}
          {criteria.cabin} · {criteria.travellers}{" "}
          {criteria.travellers === 1 ? "traveller" : "travellers"}
        </p>
      </header>

      <form className="results__controls card" method="get">
        {/* Preserve the Search_Criteria across control submits (Req 28.1). */}
        <HiddenCriteria criteria={criteria} />

        <div className="field results__control">
          <label htmlFor="sort">
            <span>Sort by</span>
          </label>
          <select id="sort" name="sort" defaultValue={sort}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field results__control">
          <label htmlFor="maxStops">
            <span>Stops</span>
          </label>
          <select id="maxStops" name="maxStops" defaultValue={maxStops}>
            {STOP_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className="cta results__apply">
          Apply
        </button>
      </form>

      {offers.length === 0 ? (
        <p className="results__empty card">
          No flights match these criteria. Try widening the stops filter or
          editing your search.
        </p>
      ) : (
        <ul className="offer-list">
          {offers.map((offer) => (
            <FlightOfferCard
              key={offer.id}
              offer={offer}
              travellers={criteria.travellers}
              query={query}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * Hidden inputs that carry the parsed Search_Criteria through a GET control
 * submission, so applying a sort/filter preserves the criteria in the URL
 * (Req 28.1). Only the fields present on the criteria are emitted, matching the
 * serializer's optional-field rules (e.g. `returnDate` only for round-trip).
 */
function HiddenCriteria({ criteria }: { criteria: FlightsCriteria }) {
  return (
    <>
      <input type="hidden" name="category" value="flights" />
      <input type="hidden" name="tripType" value={criteria.tripType} />
      <input type="hidden" name="origin" value={criteria.origin} />
      <input type="hidden" name="destination" value={criteria.destination} />
      <input type="hidden" name="departDate" value={criteria.departDate} />
      {criteria.returnDate !== undefined && (
        <input type="hidden" name="returnDate" value={criteria.returnDate} />
      )}
      <input type="hidden" name="travellers" value={String(criteria.travellers)} />
      <input type="hidden" name="cabin" value={criteria.cabin} />
    </>
  );
}

/** Serialize Next's raw searchParams back into a query string for parseCriteria. */
function serializeRaw(raw: RawSearchParams): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) p.set(k, v[0]);
    } else {
      p.set(k, v);
    }
  }
  return p.toString();
}
