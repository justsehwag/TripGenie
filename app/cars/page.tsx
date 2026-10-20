import Link from "next/link";

import { parseCriteria, serializeCriteria, type CarsCriteria } from "@/lib/search-criteria";
import { runSearch } from "@/lib/search";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import type { CarOffer } from "@/lib/types";
import ProvenanceLabel from "@/components/provenance-label";

export const metadata = { title: "Cars - TripGenie" };

/**
 * Cars Results_Page (server component) — design "Booking Site ▸ Results_Page",
 * Req 25.6/25.7/25.8/25.9/25.11.
 *
 * This is a SERVER component: it reads `searchParams`, parses them into typed
 * `CarsCriteria` via `parseCriteria("cars", …)`, and calls the Search_API
 * (`runSearch`) for the car offer set. Because the search is reproduced purely
 * from the URL, opening or refreshing a results URL reruns the identical search
 * (Req 25.6, 28.1) — no client state is involved.
 *
 * It renders a results summary (pickup location + count), a sort control and
 * filter controls (plain GET forms that re-encode the URL so they also survive
 * refresh), and one `CarOffer` card per result. Every card shows the car offer
 * fields and its `OfferMeta` provenance label (mandatory, Req 25.8 / 9.4); when
 * the provenance is estimated the card's disclosure states no payment is taken
 * and no valid rental is issued (Req 25.11). Each card links to `/cars/[id]`
 * (Req 25.9 / 9.3).
 *
 * UI redesign (Req 9.1-9.5): the search/sort/filter controls, result cards, and
 * their vehicle facts use the shared minimalist Design_System classes
 * (`.shell`, `.results-controls`, `.field`, `.offer-card`, `.offer-card__facts`,
 * `.offer-card__price`, `.cta`, `.provenance`) on white surfaces with green
 * accents — no legacy glass/dark/emoji/hardcoded colors.
 */

/** Next 16 passes route search params as a promise. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Sort options exposed on the cars results page. */
type CarSort = "price" | "seats" | "class";
const CAR_SORTS: { value: CarSort; label: string }[] = [
  { value: "price", label: "Price (per day)" },
  { value: "seats", label: "Seats" },
  { value: "class", label: "Car class" },
];

const CAR_CLASSES = ["Economy", "Compact", "SUV", "Luxury"] as const;
const TRANSMISSIONS = ["automatic", "manual"] as const;

/** Flatten a single search param to a string (first value wins). */
function one(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

/** Rebuild the query string from a record, dropping empty values. */
function queryStringFrom(params: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const flat = one(value);
    if (flat !== undefined && flat !== "") p.set(key, flat);
  }
  return p.toString();
}

/** Inclusive-day rental length from ISO pickup/return dates; defaults to 1. */
function rentalDaysFromCriteria(c: CarsCriteria): number {
  if (!c.pickupDate || !c.returnDate) return 1;
  const start = Date.parse(c.pickupDate);
  const end = Date.parse(c.returnDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.round((end - start) / dayMs));
}

/** Map parsed Cars criteria onto the Inventory Adapter query the Search_API takes. */
function toInventoryQuery(c: CarsCriteria): InventoryQuery {
  return {
    origin: "",
    destination: c.pickupLocation,
    cabin: "Economy",
    stayStyle: "Comfort",
    nights: rentalDaysFromCriteria(c),
    pickupLocation: c.pickupLocation,
    dropoffLocation: c.dropoffLocation,
    rentalDays: rentalDaysFromCriteria(c),
  };
}

/** Apply sort + filters to the car offers deterministically. */
function arrangeOffers(
  offers: CarOffer[],
  sort: CarSort,
  filterClass: string | undefined,
  filterTransmission: string | undefined,
): CarOffer[] {
  let out = offers;
  if (filterClass) out = out.filter((o) => o.carClass === filterClass);
  if (filterTransmission) out = out.filter((o) => o.transmission === filterTransmission);

  const sorted = [...out];
  switch (sort) {
    case "price":
      sorted.sort((a, b) => a.pricePerDay - b.pricePerDay);
      break;
    case "seats":
      sorted.sort((a, b) => b.seats - a.seats);
      break;
    case "class":
      sorted.sort((a, b) => a.carClass.localeCompare(b.carClass));
      break;
  }
  return sorted;
}

function money(n: number): string {
  return `₹${n.toLocaleString("en-IN")}`;
}

export default async function CarsResultsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const raw = await searchParams;
  const qs = queryStringFrom(raw);

  // Reproduce the search purely from the URL (Req 25.6 / 28.1).
  const criteria = parseCriteria("cars", qs) as CarsCriteria;
  const canonicalQs = serializeCriteria(criteria);

  const sort = (one(raw.sort) as CarSort) ?? "price";
  const activeSort: CarSort = CAR_SORTS.some((s) => s.value === sort) ? sort : "price";
  const filterClass = one(raw.carClass);
  const filterTransmission = one(raw.transmission);

  const hasSearch = criteria.pickupLocation.trim().length > 0;
  const result = hasSearch
    ? runSearch(toInventoryQuery(criteria))
    : null;

  const offers = result
    ? arrangeOffers(result.cars, activeSort, filterClass, filterTransmission)
    : [];

  return (
    <main className="shell cars-results motion-rise">
      <p className="eyebrow">Car rental</p>
      <h1>Rental cars</h1>

      {result?.error ? (
        /* Search_API failure/timeout (Req 28.4 / 4.3): render the labelled
           error and a retry control that resubmits the SAME criteria URL. */
        <section className="card results__error" role="alert">
          <p>{result.error}</p>
          <Link className="cta" href={`/cars${canonicalQs ? `?${canonicalQs}` : ""}`}>
            Retry search
          </Link>
        </section>
      ) : !hasSearch ? (
        <p className="lead" role="note">
          Add a pickup location to search rental cars. Start from the{" "}
          <Link href="/" className="inline-link">
            Cars search
          </Link>
          .
        </p>
      ) : (
        <>
          {/* Results summary: pickup location + count (Req 25.8). */}
          <p className="results-summary lead">
            {offers.length} rental {offers.length === 1 ? "car" : "cars"} in{" "}
            <strong>{criteria.pickupLocation}</strong>
            {criteria.dropoffLocation && criteria.dropoffLocation !== criteria.pickupLocation ? (
              <>
                {" "}
                · drop-off <strong>{criteria.dropoffLocation}</strong>
              </>
            ) : null}
          </p>

          {/* Sort + filter controls — plain GET forms so refresh re-encodes the
              same URL (Req 25.8 / 28.1). Hidden fields preserve the criteria. */}
          <form method="get" action="/cars" className="results-controls" role="search" aria-label="Sort and filter rental cars">
            <CriteriaHiddenFields qs={canonicalQs} />

            <label className="field control-field">
              <span>Sort by</span>
              <select name="sort" defaultValue={activeSort}>
                {CAR_SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field control-field">
              <span>Car class</span>
              <select name="carClass" defaultValue={filterClass ?? ""}>
                <option value="">All classes</option>
                {CAR_CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <label className="field control-field">
              <span>Transmission</span>
              <select name="transmission" defaultValue={filterTransmission ?? ""}>
                <option value="">Any</option>
                {TRANSMISSIONS.map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>

            <button type="submit" className="cta control-submit">
              Apply
            </button>
          </form>

          {offers.length === 0 ? (
            <p className="empty-state lead" role="note">
              No rental cars match these filters. Try widening the car class or
              transmission.
            </p>
          ) : (
            <ul className="offer-list" aria-label="Rental car results">
              {offers.map((offer) => (
                <li key={offer.id}>
                  <CarCard offer={offer} criteriaQs={canonicalQs} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

/** Serialize the current criteria into hidden fields so a GET form preserves it. */
function CriteriaHiddenFields({ qs }: { qs: string }) {
  const entries = [...new URLSearchParams(qs).entries()];
  return (
    <>
      {entries.map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/**
 * One CarOffer card (Req 25.8/25.9/25.11, 9.2/9.3/9.4). Shows the practical
 * vehicle details the data provides — carClass, transmission, seats — alongside
 * the rental logistics (pickup/drop-off, length) in an `.offer-card__facts`
 * definition list, the per-day price with a clear primary-vs-secondary
 * hierarchy, and the mandatory `OfferMeta` provenance label on every card
 * (Req 9.4). The card is a clean white `.card` surface with green accents (no
 * legacy glass). The whole card links to the car Detail_Page, carrying the
 * criteria so the detail page reproduces the same offer set (Req 25.9 / 9.3).
 */
function CarCard({ offer, criteriaQs }: { offer: CarOffer; criteriaQs: string }) {
  const href = `/cars/${encodeURIComponent(offer.id)}${criteriaQs ? `?${criteriaQs}` : ""}`;
  const total = offer.pricePerDay * offer.days;
  const transmission = offer.transmission[0].toUpperCase() + offer.transmission.slice(1);
  return (
    <Link
      href={href}
      className="offer-card card motion-rise"
      aria-label={`${offer.carClass} rental, ${money(offer.pricePerDay)} per day`}
    >
      <div className="offer-card__head">
        <h2 className="offer-card__title">{offer.carClass}</h2>
        <span className="offer-card__tag">
          {transmission} · {offer.seats} seats
        </span>
      </div>

      {/* Practical vehicle details (Req 9.2). */}
      <dl className="offer-card__facts">
        <div>
          <dt>Class</dt>
          <dd>{offer.carClass}</dd>
        </div>
        <div>
          <dt>Transmission</dt>
          <dd>{transmission}</dd>
        </div>
        <div>
          <dt>Seats</dt>
          <dd>{offer.seats}</dd>
        </div>
        <div>
          <dt>Pickup</dt>
          <dd>{offer.pickupLocation}</dd>
        </div>
        <div>
          <dt>Drop-off</dt>
          <dd>{offer.dropoffLocation}</dd>
        </div>
        <div>
          <dt>Rental length</dt>
          <dd>
            {offer.days} {offer.days === 1 ? "day" : "days"}
          </dd>
        </div>
      </dl>

      {/* Per-day price with clear primary vs secondary hierarchy. */}
      <div className="offer-card__price">
        <span className="offer-card__price-main">{money(offer.pricePerDay)}</span>
        <span className="offer-card__price-unit"> / day</span>
        <span className="offer-card__price-total">Est. {money(total)} total</span>
      </div>

      {/* Mandatory provenance label on every card (Req 25.8 / 9.4); estimated
          carries the no-payment / no-rental disclosure (Req 25.11). */}
      <ProvenanceLabel meta={offer.meta} />
    </Link>
  );
}
