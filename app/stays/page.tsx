/**
 * Stays Results_Page (task 34.1, Req 23.5–23.7, 23.10, 28.1).
 *
 * A SERVER component. It reads `searchParams`, parses them into a
 * `StaysCriteria` with `parseCriteria("stays", …)`, and reproduces the search
 * on load/refresh by calling the Search_API (`runSearch` in lib/search.ts) —
 * so opening or refreshing the URL yields the identical result set (Req 28.1,
 * 23.5). It renders:
 *   - a results summary (destination + number of stay offers) (Req 23.6),
 *   - a sort control and filter controls (Req 23.6),
 *   - one StayOfferCard per StayOffer, each showing the offer fields and its
 *     OfferMeta provenance label; estimated offers carry the no-payment /
 *     no-valid-room disclosure (Req 23.7, 23.10).
 *
 * Sort and filter are expressed as URL query params and applied on the server,
 * keeping this a pure server component (no client JS): the controls are a GET
 * form that re-navigates with the chosen params, so a refresh reproduces the
 * same filtered/sorted view (Req 28.1). Provenance labelling is mandatory on
 * every rendered offer and nothing is fabricated — the estimator already labels
 * every estimated offer on the server (Req 4 honesty).
 */

import Link from "next/link";
import { parseCriteria, serializeCriteria, type StaysCriteria } from "@/lib/search-criteria";
import { runSearch } from "@/lib/search";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import type { StayOffer } from "@/lib/types";
import StayOfferCard from "@/components/stay-offer-card";

export const metadata = { title: "Stays - TripGenie" };

/** Next 16 passes searchParams as a Promise of a string→string|string[] map. */
type SearchParams = Record<string, string | string[] | undefined>;

/** Read a single string value from the raw searchParams map. */
function one(params: SearchParams, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Nights between two ISO dates (checkOut − checkIn); at least 1 for pricing. */
function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 1;
  const a = Date.parse(checkIn);
  const b = Date.parse(checkOut);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

type SortOption = "recommended" | "price-asc" | "price-desc";
const SORTS: { id: SortOption; label: string }[] = [
  { id: "recommended", label: "Recommended" },
  { id: "price-asc", label: "Price: low to high" },
  { id: "price-desc", label: "Price: high to low" },
];

const STAY_STYLES = ["Any", "Budget", "Comfort", "Luxury"];

/** Sort a copy of the offers by the chosen option (recommended = adapter order). */
function sortOffers(offers: StayOffer[], sort: SortOption): StayOffer[] {
  if (sort === "price-asc") return [...offers].sort((a, b) => a.pricePerNight - b.pricePerNight);
  if (sort === "price-desc") return [...offers].sort((a, b) => b.pricePerNight - a.pricePerNight);
  return offers;
}

export default async function StaysResultsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;

  // Parse the Search_Criteria from the URL (total; defaults fill any gaps).
  const criteria = parseCriteria("stays", new URLSearchParams(flatten(raw)).toString()) as StaysCriteria;

  // Optional view params (sort + stay-style filter) are not part of the
  // criteria contract; they drive server-side presentation only.
  const sortParam = one(raw, "sort");
  const sort: SortOption = SORTS.some((s) => s.id === sortParam)
    ? (sortParam as SortOption)
    : "recommended";
  const styleFilterRaw = one(raw, "stayStyle") ?? "Any";
  const styleFilter = STAY_STYLES.includes(styleFilterRaw) ? styleFilterRaw : "Any";

  // Reproduce the search (Req 23.5): map criteria → InventoryQuery and run it.
  const query: InventoryQuery = {
    origin: "",
    destination: criteria.destination,
    cabin: "economy",
    stayStyle: styleFilter === "Any" ? "Comfort" : styleFilter,
    nights: nightsBetween(criteria.checkIn, criteria.checkOut),
  };
  const result = runSearch(query);
  const offers = sortOffers(result.hotels, sort);

  // The criteria query string is forwarded to each detail link (Req 28.1).
  const criteriaQuery = serializeCriteria(criteria);
  const destinationLabel = criteria.destination || "your destination";

  return (
    <main className="shell results">
      <section className="results__summary motion-rise" aria-label="Results summary">
        <p className="eyebrow">Stays</p>
        <h1>
          {result.error
            ? `We couldn't load stays for ${destinationLabel}`
            : `${offers.length} ${offers.length === 1 ? "stay" : "stays"} in ${destinationLabel}`}
        </h1>
        {!result.error && result.partial.hotels && (
          <p className="results__partial">Showing a partial set — fewer than six stays were available.</p>
        )}
        <p className="results__edit">
          <Link href="/" className="results__edit-link">
            Edit search
          </Link>
        </p>
      </section>

      {result.error ? (
        <section className="booking-surface results__error" role="alert">
          <p>{result.error}</p>
          <Link className="cta" href={`/stays?${criteriaQuery}`}>
            Retry search
          </Link>
        </section>
      ) : (
        <>
          {/* Sort + filter controls — a GET form so the server re-renders the
              same criteria with the chosen view params (Req 23.6, 28.1). */}
          <form className="booking-surface results__controls" method="get" action="/stays">
            {/* Preserve the parsed criteria across control submissions. */}
            <input type="hidden" name="destination" value={criteria.destination} />
            <input type="hidden" name="checkIn" value={criteria.checkIn} />
            <input type="hidden" name="checkOut" value={criteria.checkOut} />
            <input type="hidden" name="guests" value={String(criteria.guests)} />
            <input type="hidden" name="rooms" value={String(criteria.rooms)} />

            <label className="field">
              <span>Sort by</span>
              <select name="sort" defaultValue={sort}>
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Stay style</span>
              <select name="stayStyle" defaultValue={styleFilter}>
                {STAY_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <button type="submit" className="cta results__apply">
              Apply
            </button>
          </form>

          {offers.length === 0 ? (
            <section className="booking-surface results__empty">
              <p>No stays matched your search.</p>
              <p>Try a different destination or adjust your dates.</p>
              <Link className="cta" href="/">
                Edit search
              </Link>
            </section>
          ) : (
            <section className="results__grid" aria-label="Stay offers">
              {offers.map((offer) => (
                <StayOfferCard key={offer.id} offer={offer} criteriaQuery={criteriaQuery} />
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}

/** Flatten a raw searchParams map into [key, value] pairs for URLSearchParams. */
function flatten(raw: SearchParams): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) pairs.push([k, v[0]]);
    } else {
      pairs.push([k, v]);
    }
  }
  return pairs;
}
