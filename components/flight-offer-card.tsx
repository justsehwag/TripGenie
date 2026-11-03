import Link from "next/link";
import type { FlightOffer } from "@/lib/types";
import { flightOfferFare } from "@/lib/workspace";
import { ProvenanceLabel, EstimatedNotice } from "@/components/offer-provenance";

/**
 * Flight offer row (Req 24.9, 24.10, 24.12). Presentational server component:
 * a single wide row showing the flight number + cabin, depart/arrive times and
 * cities, duration + stops, value highlights, the fare per person and the fare
 * multiplied by the traveller count (Pricing Engine via `flightOfferFare`), the
 * OfferMeta provenance label and - when estimated - the no-payment / no-ticket
 * disclosure. The row links to the flight Detail_Page carrying the search query
 * so the detail page reproduces the identical result set (Req 24.10).
 *
 * Nothing here is invented: there is no airline name, baggage allowance or fare
 * rule in the offer data, so none is shown. The "Top pick" badge, match % and
 * highlights come from `rankFlights`, a deterministic score over each offer's
 * REAL fare, duration, stops and departure time.
 */

/** INR currency formatter shared across the flights surfaces. */
export const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/**
 * Minutes between an ISO `HH:MM` departure and arrival, treating an arrival that
 * is not after departure as landing the next day. Pure and deterministic, so
 * the results page can sort by it without any clock dependency (Req 24.8).
 */
export function flightDurationMinutes(depart: string, arrive: string): number {
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map((n) => Number.parseInt(n, 10));
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const d = toMin(depart);
  const a = toMin(arrive);
  const span = a > d ? a - d : a + 24 * 60 - d;
  return span;
}

/** Format a minute count as `Xh Ym` for display. */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Derived, data-backed insight for one offer within its result set. */
export interface FlightInsight {
  /** 0-100 value score from fare, duration and stops relative to the set. */
  matchPct: number;
  /** True for the single best-scoring offer in the set. */
  topPick: boolean;
  /** Up to two factual highlights (e.g. "Lowest fare", "Non-stop"). */
  highlights: string[];
  /**
   * Optional plain-language reason for the pick, supplied by the Pick_Engine
   * when this estimate row is the AI's pick (Req 15.2). Purely additive: when
   * absent the card renders exactly as before, so `rankFlights` and every
   * existing caller remain unchanged.
   */
  reason?: string;
}

/**
 * Score every offer against the others in the same result set. Pure: the same
 * offers always yield the same insights. Weighting: fare 50%, duration 30%,
 * direct 20%. Highlights only state facts that hold for that offer.
 */
export function rankFlights(offers: FlightOffer[]): Record<string, FlightInsight> {
  const out: Record<string, FlightInsight> = {};
  if (offers.length === 0) return out;
  const durs = offers.map((o) => flightDurationMinutes(o.depart, o.arrive));
  const minFare = Math.min(...offers.map((o) => o.farePerPerson));
  const minDur = Math.min(...durs);
  const scores = offers.map((o, i) => {
    const price = o.farePerPerson > 0 ? minFare / o.farePerPerson : 0;
    const time = durs[i] > 0 ? minDur / durs[i] : 0;
    const direct = o.stops === 0 ? 1 : 0.8;
    return 0.5 * price + 0.3 * time + 0.2 * direct;
  });
  const best = Math.max(...scores);
  const bestIndex = scores.indexOf(best);
  offers.forEach((o, i) => {
    const h: string[] = [];
    if (i === bestIndex) h.push("Best overall value");
    if (o.farePerPerson === minFare) h.push("Lowest fare");
    if (durs[i] === minDur) h.push("Fastest");
    if (o.stops === 0) h.push("Non-stop");
    const hour = Number.parseInt(o.depart.slice(0, 2), 10);
    if (Number.isFinite(hour) && hour >= 7 && hour <= 20) h.push("Convenient timing");
    out[o.id] = {
      matchPct: Math.max(0, Math.min(100, Math.round(scores[i] * 100))),
      topPick: i === bestIndex,
      highlights: Array.from(new Set(h)).slice(0, 2),
    };
  });
  return out;
}

function PlaneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 15.5v-1.8l-8-4.9V3.5a1.5 1.5 0 00-3 0v5.3l-8 4.9v1.8l8-2.4v5.1l-2 1.5V21l3.5-1 3.5 1v-1.3l-2-1.5v-5.1l8 2.4z"
        fill="currentColor"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function FlightOfferCard({
  offer,
  travellers,
  query,
  insight,
}: {
  offer: FlightOffer;
  travellers: number;
  query: string;
  insight?: FlightInsight;
}) {
  const fare = flightOfferFare(offer.farePerPerson, travellers);
  const duration = flightDurationMinutes(offer.depart, offer.arrive);
  const nextDay = flightDurationMinutes(offer.depart, offer.arrive) + toMinutes(offer.depart) >= 24 * 60;
  const stopsLabel =
    offer.stops === 0 ? "Direct" : offer.stops === 1 ? "1 stop" : `${offer.stops} stops`;
  const href = `/flights/${encodeURIComponent(offer.id)}${query ? `?${query}` : ""}`;
  const travellerWord = fare.travellers === 1 ? "traveller" : "travellers";

  return (
    <li className="offer-card flight-row">
      <Link
        className="offer-card__link flight-row__link"
        href={href}
        aria-label={`${offer.flightNo}, ${offer.origin} to ${offer.destination}, departs ${offer.depart}, ${stopsLabel}, ${inr.format(fare.perPerson)} per person`}
      >
        <div className="flight-row__pick">
          {insight?.topPick && <span className="flight-row__badge">Top pick</span>}
          {insight && <span className="flight-row__match">{insight.matchPct}% match</span>}
          {insight?.topPick && insight.reason ? (
            <span className="flight-row__reason">{insight.reason}</span>
          ) : null}
        </div>

        <div className="flight-row__carrier">
          <span className="flight-row__icon">
            <PlaneIcon />
          </span>
          <span className="flight-row__carrier-text">
            <span className="flight-row__flightno">{offer.flightNo}</span>
            <span className="flight-row__cabin">
              {offer.cabin} {"\u00B7"} {offer.stops === 0 ? "Non-stop" : stopsLabel}
            </span>
          </span>
        </div>

        <div className="flight-row__time">
          <span className="flight-row__clock">{offer.depart}</span>
          <span className="flight-row__city">{offer.origin}</span>
        </div>

        <div className="flight-row__path">
          <span className="flight-row__duration">{formatDuration(duration)}</span>
          <span className="flight-row__line">
            <span className="flight-row__plane">
              <PlaneIcon size={14} />
            </span>
          </span>
          <span className="flight-row__stops">{stopsLabel}</span>
        </div>

        <div className="flight-row__time flight-row__time--arrive">
          <span className="flight-row__clock">
            {offer.arrive}
            {nextDay && <sup className="flight-row__nextday">+1</sup>}
          </span>
          <span className="flight-row__city">{offer.destination}</span>
        </div>

        <ul className="flight-row__info">
          <li className="flight-row__date">
            <CalendarIcon />
            {offer.date}
          </li>
          {(insight?.highlights ?? []).map((h) => (
            <li key={h} className="flight-row__highlight">
              <CheckIcon />
              {h}
            </li>
          ))}
        </ul>

        <div className="flight-row__price">
          <ProvenanceLabel meta={offer.meta} />
          <span className="flight-row__amount">{inr.format(fare.perPerson)}</span>
          <span className="flight-row__unit">per person</span>
          <span className="flight-row__total">
            {inr.format(fare.party)} total {"\u00B7"} {fare.travellers} {travellerWord}
          </span>
          <span className="flight-row__select">Select flight</span>
        </div>
      </Link>

      <EstimatedNotice meta={offer.meta} />
    </li>
  );
}

/** Minutes since midnight for an `HH:MM` string. */
function toMinutes(t: string): number {
  const [h, m] = t.split(":").map((n) => Number.parseInt(n, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}