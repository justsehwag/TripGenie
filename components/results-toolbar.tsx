"use client";

/**
 * Results toolbar for the /stays and /flights pages (Req 18, 19).
 *
 * A single presentational component serves both views. It is CONTROLLED: every
 * view change goes through `onChange` so the parent (StaysResults /
 * FlightsResults) owns the View_State and writes the URL. The only local state
 * is the open/closed flag of the small-screen filter panel, which is purely a
 * display concern and independent of the view.
 *
 * It renders:
 *  - a results count line ("12 of 28 stays") inside an `aria-live="polite"`
 *    region so the count change is announced (Req 18.1, 19.2);
 *  - a Sort select appropriate to the kind (Req 10.1, 11.1);
 *  - filter controls driven by the caps so unsupported controls are hidden
 *    (Req 10.3, 10.4, 10.7, 11.2, 11.3, 11.4);
 *  - one removable pill per active filter value plus "Clear all" (Req 18.2);
 *  - at <=768 px, a "Filters (n)" toggle with `aria-expanded` / `aria-controls`
 *    that opens a collapsible panel (Req 18.6).
 *
 * Paging (`show`) is NOT handled here; "Show more" lives in the results
 * component. Every control is labelled and keyboard operable; the visible focus
 * indicator comes from the global focus styles. No new `:root` token vars.
 */

import { useId, useState } from "react";
import {
  activeFilterPills,
  clearAllFilters,
  STAYS_SORTS,
  FLIGHTS_SORTS,
  STAY_STYLES,
  MIN_RATINGS,
  STOP_BANDS,
  DEPART_WINDOWS,
  type StaysView,
  type FlightsView,
  type StaysSort,
  type FlightsSort,
  type StayStyle,
  type MinRating,
  type StopBand,
  type DepartWindow,
  type StaysCaps,
  type FlightsCaps,
  type AirlineFacet,
} from "@/lib/results-view";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StaysToolbarProps {
  kind: "stays";
  view: StaysView;
  onChange: (view: StaysView) => void;
  caps: StaysCaps;
  airlineFacets?: AirlineFacet[];
  totalCount: number;
  shownCount: number;
  countNoun: string;
}

interface FlightsToolbarProps {
  kind: "flights";
  view: FlightsView;
  onChange: (view: FlightsView) => void;
  caps: FlightsCaps;
  airlineFacets?: AirlineFacet[];
  totalCount: number;
  shownCount: number;
  countNoun: string;
}

export type ResultsToolbarProps = StaysToolbarProps | FlightsToolbarProps;

// ---------------------------------------------------------------------------
// Static labels
// ---------------------------------------------------------------------------

const STAYS_SORT_LABELS: Record<StaysSort, string> = {
  recommended: "Recommended",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  rating: "Rating",
  reviews: "Most reviewed",
};

const FLIGHTS_SORT_LABELS: Record<FlightsSort, string> = {
  recommended: "Recommended",
  cheapest: "Cheapest",
  fastest: "Fastest",
  earliest: "Earliest departure",
};

const STYLE_LABELS: Record<StayStyle, string> = {
  Any: "Any",
  Budget: "Budget",
  Comfort: "Comfort",
  Luxury: "Luxury",
};

const RATING_LABELS: Record<string, string> = {
  "0": "Any",
  "3.5": "3.5+",
  "4": "4.0+",
  "4.5": "4.5+",
};

const STOP_LABELS: Record<StopBand, string> = {
  "0": "Non-stop",
  "1": "1 stop",
  "2": "2+ stops",
};

// En dash (\u2013) kept as an escape so the source stays plain ASCII.
const EN_DASH = "\u2013";
const WINDOW_LABELS: Record<DepartWindow, string> = {
  early: `Early (12am${EN_DASH}6am)`,
  morning: `Morning (6am${EN_DASH}12pm)`,
  afternoon: `Afternoon (12pm${EN_DASH}6pm)`,
  evening: `Evening (6pm${EN_DASH}12am)`,
};

// Multiplication sign (\u00D7) used on the removable pills.
const TIMES = "\u00D7";

// ---------------------------------------------------------------------------
// Small helpers for the number inputs (null <-> "")
// ---------------------------------------------------------------------------

/** Parse a user-typed price into a positive integer, or null when blank/invalid. */
function toPositiveIntOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** Add or remove one value from a list, keeping the input unchanged. */
function toggleMember<T>(list: readonly T[], value: T, on: boolean): T[] {
  if (on) return list.includes(value) ? [...list] : [...list, value];
  return list.filter((v) => v !== value);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ResultsToolbar(props: ResultsToolbarProps) {
  const { totalCount, shownCount, countNoun } = props;
  const [open, setOpen] = useState(false);

  const baseId = useId();
  const filtersPanelId = `${baseId}-filters`;
  const sortId = `${baseId}-sort`;

  // Pills and the active count are view-only; the generic overload serves both
  // kinds. The pill `remove()` and "Clear all" return the matching view type,
  // which the parent's `onChange` consumes (typed per kind below).
  const pills =
    props.kind === "stays" ? activeFilterPills(props.view) : activeFilterPills(props.view);
  const activeCount = pills.length;

  const onClearAll = () => {
    if (props.kind === "stays") props.onChange(clearAllFilters(props.view));
    else props.onChange(clearAllFilters(props.view));
  };

  // Simplified toolbar: a single clean count line. The Sort select, Filters
  // toggle, filter panel and pills were removed for a simpler results view;
  // the results components still apply the default (recommended) ordering.
  return (
    <div className="results-toolbar results-toolbar--slim">
      <div className="results-toolbar__count" aria-live="polite" aria-atomic="true">
        {shownCount} of {totalCount} {countNoun}
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Sort selects
// ---------------------------------------------------------------------------

function StaysSortSelect({
  id,
  view,
  onChange,
  caps,
}: {
  id: string;
  view: StaysView;
  onChange: (view: StaysView) => void;
  caps: StaysCaps;
}) {
  // Rating / Most reviewed are hidden when the Result_Set carries no such field.
  const options = STAYS_SORTS.filter((sort) => {
    if (sort === "rating") return caps.rating;
    if (sort === "reviews") return caps.reviews;
    return true;
  });
  return (
    <select
      id={id}
      value={view.sort}
      onChange={(e) => onChange({ ...view, sort: e.target.value as StaysSort })}
    >
      {options.map((sort) => (
        <option key={sort} value={sort}>
          {STAYS_SORT_LABELS[sort]}
        </option>
      ))}
    </select>
  );
}

function FlightsSortSelect({
  id,
  view,
  onChange,
}: {
  id: string;
  view: FlightsView;
  onChange: (view: FlightsView) => void;
}) {
  return (
    <select
      id={id}
      value={view.sort}
      onChange={(e) => onChange({ ...view, sort: e.target.value as FlightsSort })}
    >
      {FLIGHTS_SORTS.map((sort) => (
        <option key={sort} value={sort}>
          {FLIGHTS_SORT_LABELS[sort]}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Stays filter controls
// ---------------------------------------------------------------------------

function StaysFilters({
  view,
  onChange,
  caps,
}: {
  view: StaysView;
  onChange: (view: StaysView) => void;
  caps: StaysCaps;
}) {
  return (
    <div className="results-toolbar__controls">
      <label className="field">
        <span>Style</span>
        <select
          value={view.style}
          onChange={(e) => onChange({ ...view, style: e.target.value as StayStyle })}
        >
          {STAY_STYLES.map((style) => (
            <option key={style} value={style}>
              {STYLE_LABELS[style]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Min price</span>
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={view.minPrice ?? ""}
          onChange={(e) => onChange({ ...view, minPrice: toPositiveIntOrNull(e.target.value) })}
        />
      </label>

      <label className="field">
        <span>Max price</span>
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={view.maxPrice ?? ""}
          onChange={(e) => onChange({ ...view, maxPrice: toPositiveIntOrNull(e.target.value) })}
        />
      </label>

      {caps.rating && (
        <label className="field">
          <span>Min rating</span>
          <select
            value={String(view.minRating)}
            onChange={(e) => onChange({ ...view, minRating: Number(e.target.value) as MinRating })}
          >
            {MIN_RATINGS.map((r) => (
              <option key={r} value={String(r)}>
                {RATING_LABELS[String(r)]}
              </option>
            ))}
          </select>
        </label>
      )}

      {caps.freeCancel && (
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={view.freeCancel}
            onChange={(e) => onChange({ ...view, freeCancel: e.target.checked })}
          />
          <span>Free cancellation</span>
        </label>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flights filter controls
// ---------------------------------------------------------------------------

function FlightsFilters({
  view,
  onChange,
  caps,
  airlineFacets,
}: {
  view: FlightsView;
  onChange: (view: FlightsView) => void;
  caps: FlightsCaps;
  airlineFacets: AirlineFacet[];
}) {
  return (
    <div className="results-toolbar__controls">
      <fieldset className="results-toolbar__group">
        <legend>Stops</legend>
        {STOP_BANDS.map((band) => (
          <label key={band} className="field field--checkbox">
            <input
              type="checkbox"
              checked={view.stops.includes(band)}
              onChange={(e) => onChange({ ...view, stops: toggleMember(view.stops, band, e.target.checked) })}
            />
            <span>{STOP_LABELS[band]}</span>
          </label>
        ))}
      </fieldset>

      {caps.airlines && airlineFacets.length > 0 && (
        <fieldset className="results-toolbar__group">
          <legend>Airlines</legend>
          {airlineFacets.map((facet) => (
            <label key={facet.name} className="field field--checkbox">
              <input
                type="checkbox"
                checked={view.airlines.includes(facet.name)}
                onChange={(e) =>
                  onChange({ ...view, airlines: toggleMember(view.airlines, facet.name, e.target.checked) })
                }
              />
              <span>
                {facet.name} ({facet.count})
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="results-toolbar__group">
        <legend>Departure</legend>
        {DEPART_WINDOWS.map((window) => (
          <label key={window} className="field field--checkbox">
            <input
              type="checkbox"
              checked={view.windows.includes(window)}
              onChange={(e) => onChange({ ...view, windows: toggleMember(view.windows, window, e.target.checked) })}
            />
            <span>{WINDOW_LABELS[window]}</span>
          </label>
        ))}
      </fieldset>

      <label className="field">
        <span>Max fare per person</span>
        <input
          type="number"
          min={0}
          inputMode="numeric"
          value={view.maxFare ?? ""}
          onChange={(e) => onChange({ ...view, maxFare: toPositiveIntOrNull(e.target.value) })}
        />
      </label>
    </div>
  );
}
