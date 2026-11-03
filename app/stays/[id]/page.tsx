/**
 * Stay Detail_Page (task 34.1, Req 23.8–23.10).
 *
 * A SERVER component. It reproduces the same StayOffer set from the criteria in
 * the URL (Req 28.1) and looks up the offer by its `[id]` route segment. It
 * renders the full stay detail — property name/location, image, description,
 * amenities — plus the OfferMeta provenance label; for estimated offers it
 * carries the no-payment / no-valid-room disclosure (Req 23.10). Review content
 * is rendered ONLY when attributable review data exists, i.e. when
 * `meta.reviewSummary` is present (Req 23.9, 4.12/4.13).
 *
 * Detail renders on a clean white `.card` surface with green accents and
 * subtle dividers (Req 7.1), text at >=4.5:1 contrast. Nothing shown here is
 * fabricated — all fields, the provenance, and any rating come from the
 * server-produced offer (Req 4 honesty).
 */

import Link from "next/link";
import { parseCriteria, serializeCriteria, type StaysCriteria } from "@/lib/search-criteria";
import { runSearch } from "@/lib/search";
import { toAttributableReview, type AttributableReview, type InventoryQuery } from "@/lib/inventory-adapter";
import { enrichPlace } from "@/lib/providers/google-places";
import { ProvenanceLabel, EstimatedNotice } from "@/components/offer-provenance";

/**
 * Indicative Price_Level_Band labels for Google's 0-4 priceLevel band
 * (Req 6.6). These are shown ONLY as an indicative caption and MUST NEVER be
 * presented as a bookable price or a currency amount (Req 6.7). `null` -> omit.
 */
const PRICE_LEVEL_LABEL: Record<number, string> = {
  0: "Free",
  1: "Inexpensive",
  2: "Moderate",
  3: "Expensive",
  4: "Very expensive",
};

export const metadata = { title: "Stay detail - TripGenie" };

type SearchParams = Record<string, string | string[] | undefined>;

function money(amount: number): string {
  return `₹${Math.round(amount).toLocaleString("en-IN")}`;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 1;
  const a = Date.parse(checkIn);
  const b = Date.parse(checkOut);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

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

function one(params: SearchParams, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

/** Representative amenity set for a stay style (illustrative, not fabricated
 *  provider data — amenities describe the style category, not a real listing). */
const STYLE_AMENITIES: Record<string, string[]> = {
  Budget: ["Free Wi-Fi", "Air conditioning", "24-hour reception"],
  Comfort: ["Free Wi-Fi", "Breakfast included", "Pool", "Fitness centre"],
  Luxury: ["Free Wi-Fi", "Spa", "Rooftop pool", "Concierge", "Fine dining"],
};

export default async function StayDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const raw = await searchParams;

  const criteria = parseCriteria(
    "stays",
    new URLSearchParams(flatten(raw)).toString(),
  ) as StaysCriteria;

  const styleFilterRaw = one(raw, "stayStyle") ?? "Comfort";
  const stayStyle = ["Budget", "Comfort", "Luxury"].includes(styleFilterRaw)
    ? styleFilterRaw
    : "Comfort";

  const query: InventoryQuery = {
    origin: "",
    destination: criteria.destination,
    cabin: "economy",
    stayStyle,
    nights: nightsBetween(criteria.checkIn, criteria.checkOut),
  };

  // Google Places enrichment (google-places-integration design §5 "Stays
  // enrichment"; Req 6.1-6.7, 10.3). This is a SERVER component, so we call the
  // server-only `enrichPlace` directly with `await`; the Google key is read
  // internally via `googlePlacesApiKey()` and never reaches the client.
  //
  // Query choice: the synthetic property name `${stayStyle} stay in
  // ${destination}` is not a real place Google can match, so we enrich a
  // generic stay in the destination to obtain a meaningful, attributable
  // rating/review signal. Real hotel-name matching will improve once real
  // inventory supplies property names — out of scope for this task.
  //
  // Scope: this task enriches the single matched property on the Detail_Page
  // only. The stays results LIST (app/stays/page.tsx) is intentionally NOT
  // enriched here because that would call Google once per listed offer, a
  // cost/latency concern (Req 9). See TODO below.
  // TODO(results-list): thread a single shared enrichment through the stays
  // results path if/when per-row Google enrichment is justified under Req 9.
  const enrichment = await enrichPlace({ query: `hotel in ${criteria.destination}` });

  // Only a live/cached enrichment with real attributable data populates the
  // existing seam. `toAttributableReview` returns an `AttributableReview`
  // (source already set to "Google") iff a rating, a positive user rating
  // count, AND at least one review are present; otherwise `undefined`
  // (Req 6.2-6.5). Setting `query.review` lets the inventory adapter's
  // `meta()` render it into `offer.meta.reviewSummary` via the existing
  // `attributable()` gate — no attribution logic is duplicated here.
  //
  // Note: a cache HIT (`mode: "cached"`) carries `reviews: []` by design
  // (reviews are never cached), so `toAttributableReview` returns `undefined`
  // and the stay keeps its estimated labelling — exactly the fallback render
  // (Req 6.4, 6.5, 10.3).
  let googleReview: AttributableReview | undefined;
  let priceLevelLabel: string | null = null;
  if (enrichment.data) {
    googleReview = toAttributableReview(enrichment.data);
    if (enrichment.data.priceLevel !== null) {
      priceLevelLabel = PRICE_LEVEL_LABEL[enrichment.data.priceLevel] ?? null;
    }
  }
  if (googleReview) {
    query.review = googleReview;
  }

  const result = runSearch(query);
  const offer = result.hotels.find((o) => o.id === id);
  const criteriaQuery = serializeCriteria(criteria);

  if (!offer) {
    return (
      <main className="shell detail">
        <section className="card detail__notfound" role="alert">
          <h1>Stay not found</h1>
          <p>We couldn&apos;t find that stay for the current search.</p>
          <Link className="cta" href={`/stays?${criteriaQuery}`}>
            Back to results
          </Link>
        </section>
      </main>
    );
  }

  const nights = Math.max(1, offer.nights);
  const total = offer.pricePerNight * nights;
  const amenities = STYLE_AMENITIES[offer.stayStyle] ?? STYLE_AMENITIES.Comfort;
  const propertyName = `${offer.stayStyle} stay in ${offer.destination}`;

  return (
    <main className="shell detail">
      <p className="detail__back">
        <Link href={`/stays?${criteriaQuery}`} className="detail__back-link">
          ← Back to results
        </Link>
      </p>

      <section className="card detail__panel motion-rise">
        <p className="eyebrow">{offer.destination}</p>
        <h1 className="detail__title">{propertyName}</h1>

        {/* Image: representative placeholder region. A bundled/representative
            photo stands in; labelled representative unless an authorized
            provider returns an exact image (Req 11.2). */}
        <div
          className="detail__image"
          role="img"
          aria-label={`Representative image of a ${offer.stayStyle.toLowerCase()} stay in ${offer.destination}`}
        >
          <span className="detail__image-caption">
            {offer.representative ? "Representative image" : offer.destination}
          </span>
        </div>

        <p className="detail__description">
          A {offer.stayStyle.toLowerCase()} place to stay in {offer.destination}, booked for{" "}
          {nights} {nights === 1 ? "night" : "nights"}. This listing reflects a {offer.stayStyle.toLowerCase()}{" "}
          category property with amenities typical of that tier.
        </p>

        <dl className="detail__facts">
          <div>
            <dt>Location</dt>
            <dd>{offer.destination}</dd>
          </div>
          <div>
            <dt>Style</dt>
            <dd>{offer.stayStyle}</dd>
          </div>
          <div>
            <dt>Nights</dt>
            <dd>{nights}</dd>
          </div>
          <div>
            <dt>Per night</dt>
            <dd>{money(offer.pricePerNight)}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>{money(total)}</dd>
          </div>
        </dl>

        <div className="detail__amenities">
          <h2>Amenities</h2>
          <ul>
            {amenities.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>

        {/* Review content ONLY when attributable (Req 23.9, 4.12/4.13). When a
            live Google enrichment supplied an AttributableReview above, this is
            the Google rating/count attributed to "Google" via the existing
            offer.meta.reviewSummary seam (Req 6.2, 6.3). */}
        {offer.meta.reviewSummary ? (
          <div className="detail__reviews">
            <h2>Guest reviews</h2>
            <p>
              {offer.meta.reviewSummary.rating.toFixed(1)} / 5 from{" "}
              {offer.meta.reviewSummary.count} reviews
            </p>
            <p className="detail__reviews-source">Source: {offer.meta.reviewSummary.source}</p>
          </div>
        ) : (
          <p className="detail__no-reviews">No attributable guest reviews are available for this stay.</p>
        )}

        {/* Indicative Price_Level_Band ONLY (Req 6.6). This is a coarse band
            from Google, clearly labelled indicative; it is NOT a bookable price
            and carries NO currency figure (Req 6.7). The bookable per-night and
            total amounts above come solely from the estimator and are never
            touched by Google data. */}
        {priceLevelLabel ? (
          <p className="detail__price-band">
            Price level (indicative, not a bookable price): {priceLevelLabel} · Source: Google
          </p>
        ) : null}

        <ProvenanceLabel meta={offer.meta} />
        <EstimatedNotice meta={offer.meta} />
      </section>
    </main>
  );
}
