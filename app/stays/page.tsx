/**
 * Stays Results_Page (live-travel-pricing task 12.1, Req 6.3, 9.1, 9.2, 9.4,
 * 10.6, 12.2, 21.3, 21.5).
 *
 * A SERVER component. It reads `searchParams`, parses them into a
 * `StaysCriteria` with `parseCriteria("stays", …)`, and reproduces the search
 * on load/refresh so opening or refreshing the URL yields the identical result
 * set. The View_State (sort / filter / paging) is parsed once here with
 * `parseStaysView(searchParams)` and handed to the client `<StaysResults>`,
 * which owns all sort / filter / paging / pick behaviour and renders the live
 * Hotel_List or the estimate grid — never both (Req 6.1 / 10.6).
 *
 * The server:
 *   - parses the criteria and the initial view,
 *   - runs the estimator (`runSearch`) across Budget, Comfort and Luxury so the
 *     client-side style filter has every style to work with (Req 10.6),
 *   - calls the live hotel provider (`searchHotelRates`, no hotel class — the
 *     adapter dropped `hotelClass` in task 6.1),
 *   - renders the compact `StaysSearchForm` (pre-filled, `keep` = the serialised
 *     view), the one-line Live_Notice when estimates are
 *     shown, and `<StaysResults>`.
 *
 * IST time text comes from `lib/ist-time.ts` so the server and client render
 * identical labels (Req 9.2). Nothing is fabricated: the estimator labels every
 * estimated offer and the Live_Notice says plainly when estimates are shown
 * (Req 21.3, 21.5).
 */

import Link from "next/link";
import { parseCriteria, serializeCriteria, type StaysCriteria } from "@/lib/search-criteria";
import { runSearch } from "@/lib/search";
import type { InventoryQuery } from "@/lib/inventory-adapter";
import type { StayOffer } from "@/lib/types";
import { parseStaysView, serializeStaysView } from "@/lib/results-view";
import { checkedLabel, todayIst } from "@/lib/ist-time";
import StaysPrefill from "@/components/stays-prefill";
import StaysResults from "@/components/stays-results";
import StaysSearchForm from "@/components/stays-search-form";
import { searchHotelRates, type HotelRatesResult } from "@/lib/providers/serpapi-hotels";

export const metadata = { title: "Stays - TripGenie" };

/** Next 16 passes searchParams as a Promise of a string→string|string[] map. */
type SearchParams = Record<string, string | string[] | undefined>;

/** The estimate stay styles, built in full so the client style filter works. */
const ESTIMATE_STYLES = ["Budget", "Comfort", "Luxury"] as const;

/** True when a string is a real YYYY-MM-DD date. */
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** today (IST) + n days, as YYYY-MM-DD. */
function istPlusDays(n: number): string {
  const base = new Date(`${todayIst()}T00:00:00Z`).getTime();
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Ensure a stay search has valid dates. When the URL carried a destination
 * but no (or invalid) check-in/out - e.g. the traveller arrived from the AI
 * trip without dates - default to a sensible near-future window so the LIVE
 * search runs and real photo results show instead of estimate fallbacks.
 */
function ensureStayDates(c: StaysCriteria): { checkIn: string; checkOut: string } {
  const ci = isIsoDate(c.checkIn) ? c.checkIn : istPlusDays(14);
  let co = isIsoDate(c.checkOut) ? c.checkOut : "";
  if (!isIsoDate(co) || co <= ci) co = (() => {
    const base = new Date(`${ci}T00:00:00Z`).getTime();
    return new Date(base + 3 * 86_400_000).toISOString().slice(0, 10);
  })();
  return { checkIn: ci, checkOut: co };
}

/** Nights between two ISO dates (checkOut − checkIn); at least 1 for pricing. */
function nightsBetween(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 1;
  const a = Date.parse(checkIn);
  const b = Date.parse(checkOut);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

/** Why estimates are shown instead of live prices (null when live prices are shown). */
function liveNotice(live: HotelRatesResult): string | null {
  switch (live.status) {
    case "live":
      return live.hotels.length === 0
        ? "No live prices were returned for these dates, so the stays below are estimates."
        : null;
    case "unconfigured":
      return "Live prices aren't connected yet, so the stays below are estimates.";
    case "invalid":
      return `${live.error ?? "Check your search."} The stays below are estimates.`;
    case "unavailable":
      return "Live prices are temporarily unavailable, so the stays below are estimates.";
  }
}

export default async function StaysResultsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;

  // Parse the Search_Criteria from the URL (total; defaults fill any gaps).
  const criteria = parseCriteria("stays", new URLSearchParams(flatten(raw)).toString()) as StaysCriteria;

  // Parse the initial View_State once on the server; the client owns it after.
  const view = parseStaysView(raw);

  // Shared-context prefill (Req 4.3 / 10.2): when the URL carries no destination
  // (e.g. the traveler navigated here from the concierge, where only the
  // Shared_Trip_Context holds the trip) there is no search to run. Render the
  // existing empty-state card with the client prefill affordance.
  const hasSearch = criteria.destination.trim() !== "";
  const today = todayIst();
  if (!hasSearch) {
    return (
      <main className="shell results">
        <section className="results__summary motion-rise" aria-label="Results summary">
          <p className="eyebrow">Stays</p>
          <h1>Search stays</h1>
        </section>
        {/* Live search straight from /stays (one live search per submit). */}
        <StaysSearchForm today={today} />
        <section className="card results__empty">
          <StaysPrefill />
        </section>
      </main>
    );
  }

  // Guarantee live-searchable dates (default a near-future window when the
  // trip arrived without dates), so live photo results show, not estimates.
  const resolvedDates = ensureStayDates(criteria);
  criteria.checkIn = resolvedDates.checkIn;
  criteria.checkOut = resolvedDates.checkOut;

  const nights = nightsBetween(criteria.checkIn, criteria.checkOut);

  // Build estimates across all three styles so the client-side style filter has
  // every style to work with (Req 10.6). Ids differ per style, but de-dupe by
  // id defensively so the view never sees a duplicate key.
  const offers = buildEstimateOffers(criteria, nights);

  // Live prices for the exact dates and guests (Google Hotels via SerpApi), with
  // no hotel class (the adapter dropped it in task 6.1). Falls back to the
  // labelled estimates above when unavailable.
  const live = await searchHotelRates({
    destination: criteria.destination,
    checkIn: criteria.checkIn,
    checkOut: criteria.checkOut,
    adults: criteria.guests,
  });
  const showLive = live.status === "live" && live.hotels.length > 0;
  const result = runSearch(estimateQuery(criteria, "Comfort", nights));
  const notice = showLive ? null : liveNotice(live);

  // The criteria query string is forwarded to each estimate detail link.
  const criteriaQuery = serializeCriteria(criteria);
  const destinationLabel = criteria.destination || "your destination";

  // The serialised view is kept across search edits (Req 12.6).
  const keep = Object.fromEntries(serializeStaysView(view).entries());

  return (
    <main className="shell results">
      <section className="results__summary motion-rise" aria-label="Results summary">
        <p className="eyebrow">Stays</p>
        <h1>
          {showLive
            ? `Stays with live prices in ${destinationLabel}`
            : result.error
            ? `We couldn't load stays for ${destinationLabel}`
            : `Stays in ${destinationLabel}`}
        </h1>
        {!showLive && !result.error && result.partial.hotels && (
          <p className="results__partial">Showing a partial set — fewer than six stays were available.</p>
        )}
      </section>

      {/* Edit the search in place; resubmitting runs one new live search. */}
      <StaysSearchForm
        compact
        today={today}
        initial={{
          destination: criteria.destination,
          checkIn: criteria.checkIn,
          checkOut: criteria.checkOut,
          guests: criteria.guests,
          rooms: criteria.rooms,
        }}
        keep={keep}
      />

      {result.error && !showLive ? (
        <section className="card results__error" role="alert">
          <p>{result.error}</p>
          <Link className="cta" href={`/stays?${criteriaQuery}`}>
            Retry search
          </Link>
        </section>
      ) : showLive ? (
        <StaysResults
          live
          liveHotels={live.hotels}
          initialView={view}
          criteriaQuery={criteriaQuery}
          liveCriteria={{
            destination: criteria.destination,
            checkIn: criteria.checkIn,
            checkOut: criteria.checkOut,
            adults: criteria.guests,
            rooms: criteria.rooms,
          }}
          currency={live.currency}
          nights={nights}
          provider={live.provider}
          checkedAt={live.checkedAt}
          checkedLabel={checkedLabel(live.checkedAt)}
        />
      ) : (
        <>
          {notice && (
            <p className="card live-hotel-notice" role="status">
              {notice}
            </p>
          )}
          <StaysResults
            live={false}
            estimateOffers={offers}
            initialView={view}
            criteriaQuery={criteriaQuery}
            currency="INR"
            nights={nights}
            provider=""
            checkedAt=""
            checkedLabel=""
          />
        </>
      )}
    </main>
  );
}

/** The InventoryQuery for one estimate style. */
function estimateQuery(criteria: StaysCriteria, stayStyle: string, nights: number): InventoryQuery {
  return {
    origin: "",
    destination: criteria.destination,
    cabin: "economy",
    stayStyle,
    nights,
  };
}

/** Build estimate stays across Budget, Comfort and Luxury, de-duped by id. */
function buildEstimateOffers(criteria: StaysCriteria, nights: number): StayOffer[] {
  const seen = new Set<string>();
  const out: StayOffer[] = [];
  for (const style of ESTIMATE_STYLES) {
    for (const offer of runSearch(estimateQuery(criteria, style, nights)).hotels) {
      if (seen.has(offer.id)) continue;
      seen.add(offer.id);
      out.push(offer);
    }
  }
  return out;
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
