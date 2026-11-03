"use client";

/**
 * Flights search form for the /flights page.
 *
 * Lets the traveller run a live flight-fare search straight from /flights (trip
 * type, origin, destination, dates, travellers, cabin) instead of arriving with
 * a pre-built URL. It validates with the shared `validateFlights` rules, blocks
 * past departure dates and out-of-range return dates, and navigates to
 * `/flights?<criteria>` so the server page runs ONE live search. Optional view
 * params (sort, filters) are carried over unchanged via `buildResultsHref`.
 *
 * Modelled on `components/stays-search-form.tsx` (error handling via
 * `aria-describedby`, submitting state, the `edit()` reset helper and the
 * class-name style). CSS for the `flights-search` classes is added in task 13.1.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 12.6, 19.1.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { validateFlights, type FlightsCriteria, type FlightTripType } from "@/lib/search-criteria";
import { buildResultsHref } from "@/lib/results-view";

export interface FlightsSearchFormProps {
  /** Today's date (YYYY-MM-DD, IST) computed on the server; earliest departure. */
  today: string;
  initial?: Partial<
    Pick<
      FlightsCriteria,
      "tripType" | "origin" | "destination" | "departDate" | "returnDate" | "travellers" | "cabin"
    >
  >;
  /** Extra view params to keep (e.g. sort, filters). */
  keep?: Record<string, string>;
  /** Compact = shown above results; full = empty state. */
  compact?: boolean;
}

/** Cabin options match the homepage flights form values exactly (Req 3.4). */
const CABIN_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "economy", label: "Economy" },
  { value: "premium", label: "Premium economy" },
  { value: "business", label: "Business" },
  { value: "first", label: "First" },
];

export default function FlightsSearchForm({ today, initial, keep, compact }: FlightsSearchFormProps) {
  const router = useRouter();
  const [tripType, setTripType] = useState<FlightTripType>(initial?.tripType ?? "round-trip");
  const [origin, setOrigin] = useState(initial?.origin ?? "");
  const [destination, setDestination] = useState(initial?.destination ?? "");
  const [departDate, setDepartDate] = useState(initial?.departDate ?? "");
  const [returnDate, setReturnDate] = useState(initial?.returnDate ?? "");
  const [travellers, setTravellers] = useState(String(initial?.travellers ?? 1));
  const [cabin, setCabin] = useState(initial?.cabin ?? "economy");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const isRound = tripType === "round-trip";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const t = Number.parseInt(travellers, 10);
    const found = validateFlights({
      tripType,
      origin: origin.trim(),
      destination: destination.trim(),
      departDate,
      travellers: Number.isFinite(t) ? t : undefined,
      cabin,
      ...(isRound ? { returnDate } : {}),
    });
    if (!found.departDate && departDate && departDate < today) {
      found.departDate = "Departure can't be in the past.";
    }
    if (isRound && !found.returnDate && returnDate && departDate && returnDate < departDate) {
      found.returnDate = "Return date must be on or after the departure date.";
    }
    if (!found.travellers && (t < 1 || t > 9)) {
      found.travellers = "Travellers must be between 1 and 9.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const criteria: FlightsCriteria = {
      category: "flights",
      tripType,
      origin: origin.trim(),
      destination: destination.trim(),
      departDate,
      travellers: t,
      cabin,
      ...(isRound ? { returnDate } : {}),
    };
    setSubmitting(true);
    router.push(buildResultsHref("/flights", criteria, keep));
  }

  // Reset the submitting flag when the user edits after navigating back.
  function edit<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      if (submitting) setSubmitting(false);
    };
  }

  // Swap origin and destination in place (Req 3.2).
  function swap() {
    edit(setOrigin)(destination);
    setDestination(origin);
  }

  const minReturn = departDate || today;

  return (
    <form
      className={`card flights-search${compact ? " flights-search--compact" : ""}`}
      onSubmit={submit}
      noValidate
      aria-label="Search flights"
    >
      {!compact && (
        <div className="flights-search__intro">
          <h2>Find a flight with live fares</h2>
          <p>Real fares from Google Flights for your exact dates. Book directly on the site you choose.</p>
        </div>
      )}
      <fieldset className="flights-search__triptype">
        <legend>Trip type</legend>
        <label className="field flights-search__radio">
          <input
            type="radio"
            name="tripType"
            value="round-trip"
            checked={isRound}
            onChange={() => edit(setTripType)("round-trip")}
          />
          <span>Round trip</span>
        </label>
        <label className="field flights-search__radio">
          <input
            type="radio"
            name="tripType"
            value="one-way"
            checked={!isRound}
            onChange={() => edit(setTripType)("one-way")}
          />
          <span>One way</span>
        </label>
      </fieldset>
      <div className="flights-search__fields">
        <label className="field flights-search__origin">
          <span>From</span>
          <input
            type="text"
            name="origin"
            placeholder="City or airport, e.g. Mumbai (BOM)"
            autoComplete="off"
            value={origin}
            aria-invalid={!!errors.origin}
            aria-describedby={errors.origin ? "flights-err-origin" : undefined}
            onChange={(e) => edit(setOrigin)(e.target.value)}
          />
          {errors.origin && <small id="flights-err-origin" className="field-error">{errors.origin}</small>}
        </label>
        <button
          type="button"
          className="flights-search__swap"
          aria-label="Swap origin and destination"
          onClick={swap}
        >
          {"\u21C4"}
        </button>
        <label className="field flights-search__destination">
          <span>To</span>
          <input
            type="text"
            name="destination"
            placeholder="City or airport, e.g. Goa (GOI)"
            autoComplete="off"
            value={destination}
            aria-invalid={!!errors.destination}
            aria-describedby={errors.destination ? "flights-err-destination" : undefined}
            onChange={(e) => edit(setDestination)(e.target.value)}
          />
          {errors.destination && (
            <small id="flights-err-destination" className="field-error">{errors.destination}</small>
          )}
        </label>
        <label className="field">
          <span>Depart</span>
          <input
            type="date"
            name="departDate"
            min={today}
            value={departDate}
            aria-invalid={!!errors.departDate}
            aria-describedby={errors.departDate ? "flights-err-depart" : undefined}
            onChange={(e) => {
              const v = e.target.value;
              edit(setDepartDate)(v);
              if (v && isRound && returnDate && returnDate < v) setReturnDate(v);
            }}
          />
          {errors.departDate && <small id="flights-err-depart" className="field-error">{errors.departDate}</small>}
        </label>
        <label className="field" hidden={!isRound}>
          <span>Return</span>
          <input
            type="date"
            name="returnDate"
            min={minReturn}
            disabled={!isRound}
            value={returnDate}
            aria-invalid={!!errors.returnDate}
            aria-describedby={errors.returnDate ? "flights-err-return" : undefined}
            onChange={(e) => edit(setReturnDate)(e.target.value)}
          />
          {errors.returnDate && <small id="flights-err-return" className="field-error">{errors.returnDate}</small>}
        </label>
        <label className="field flights-search__count">
          <span>Travellers</span>
          <input
            type="number"
            name="travellers"
            min={1}
            max={9}
            inputMode="numeric"
            value={travellers}
            aria-invalid={!!errors.travellers}
            aria-describedby={errors.travellers ? "flights-err-travellers" : undefined}
            onChange={(e) => edit(setTravellers)(e.target.value)}
          />
          {errors.travellers && (
            <small id="flights-err-travellers" className="field-error">{errors.travellers}</small>
          )}
        </label>
        <label className="field flights-search__cabin">
          <span>Cabin</span>
          <select
            name="cabin"
            value={cabin}
            aria-invalid={!!errors.cabin}
            aria-describedby={errors.cabin ? "flights-err-cabin" : undefined}
            onChange={(e) => edit(setCabin)(e.target.value)}
          >
            {CABIN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {errors.cabin && <small id="flights-err-cabin" className="field-error">{errors.cabin}</small>}
        </label>
        <button type="submit" className="cta flights-search__submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? "Searching\u2026" : compact ? "Update search" : "Search flights"}
        </button>
      </div>
    </form>
  );
}
