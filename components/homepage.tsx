"use client";

/**
 * Hopper-style Homepage (Req 22) — client component imported by app/page.tsx.
 *
 * Presents three Booking_Tab controls (Stays / Flights / Cars) with exactly one
 * active at a time; switching tabs swaps the shown search form with client state
 * only — no full page reload (Req 22.1/22.2). Each form builds a
 * `SearchCriteria`, validates it with the shared pure validators, and on a valid
 * submit serializes it with `serializeCriteria` and navigates to the matching
 * results route (Req 22.2, 23/24/25). Invalid submit shows field-level messages
 * and blocks navigation.
 *
 * Visually this is a Hopper-style landing: a full-bleed photographic hero with a
 * glass search panel overlapping its lower edge, a horizontally-scrolling popular
 * destinations rail (each card populates the active form via `selectDestination`,
 * Req 22.3/22.4/22.8), an editorial "exclusive deals" row clearly labelled as
 * illustrative (Req 4 honesty), a mobile-app band, and a feature-icons row. The
 * destination discovery + continue-exploring behaviours (recently-viewed from
 * browser-local storage, Req 22.9/22.10) are preserved.
 *
 * The Global_Navigation and Site_Footer are rendered by app/layout.tsx
 * (concurrent task 32.1) — NOT here (Req 22.11 satisfied by the layout).
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  serializeCriteria,
  validateStays,
  validateFlights,
  validateCars,
  type StaysCriteria,
  type FlightsCriteria,
  type CarsCriteria,
  type FlightTripType,
} from "@/lib/search-criteria";
import { DestinationImageLayer } from "@/components/destination-image";
import { illustration } from "@/lib/illustrations";

type BookingTab = "stays" | "flights" | "cars";

const TABS: { id: BookingTab; label: string }[] = [
  { id: "stays", label: "Stays" },
  { id: "flights", label: "Flights" },
  { id: "cars", label: "Cars" },
];

/** Small inline magnifier used on the finder submit button (no emoji, Req 17.6). */
function SearchGlyph() {
  return (
    <svg
      className="trip-finder__glyph"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.8" />
      <line
        x1="10.8"
        y1="10.8"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Popular destinations rail — selecting a card populates the active form.
 *
 * `blurb` is a short, generic editorial tagline (not live inventory data) so
 * each discovery card can show a brief description alongside name + country
 * (Req 6.1).
 */
const POPULAR_DESTINATIONS: { name: string; country: string; blurb: string }[] = [
  { name: "Santorini", country: "Greece", blurb: "Whitewashed cliffs and sunset calderas" },
  { name: "Bali", country: "Indonesia", blurb: "Rice terraces, temples and warm surf" },
  { name: "Tokyo", country: "Japan", blurb: "Neon districts and quiet garden corners" },
  { name: "Dubai", country: "UAE", blurb: "Desert adventure meets modern skyline" },
  { name: "Paris", country: "France", blurb: "Classic boulevards and corner cafes" },
  { name: "New York", country: "USA", blurb: "Big-city energy around every block" },
];

/** Feature icon keys — map to small inline SVGs (no emoji, Req 17.6). */
type FeatureIcon = "sparkle" | "compare" | "calendar" | "support";

/** Feature highlights shown in the icon row above the footer. */
const FEATURES: { icon: FeatureIcon; title: string; copy: string }[] = [
  { icon: "sparkle", title: "AI-powered recommendations", copy: "Personalized for your travel style" },
  { icon: "compare", title: "Best price comparison", copy: "Find the best deals" },
  { icon: "calendar", title: "Flexible booking options", copy: "Plans that fit your needs" },
  { icon: "support", title: "24/7 travel support", copy: "We're here for you" },
];

/** Small inline line-icons for the feature row (decorative, no emoji). */
function FeatureGlyph({ name }: { name: FeatureIcon }) {
  const common = {
    width: 28,
    height: 28,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
    focusable: "false" as const,
  };
  switch (name) {
    case "sparkle":
      return (
        <svg {...common}>
          <path d="M12 3l1.8 4.9L18.7 9.7 13.8 11.5 12 16.4 10.2 11.5 5.3 9.7 10.2 7.9z" />
          <path d="M18.5 3.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6L16.3 5.7l1.6-.6z" />
        </svg>
      );
    case "compare":
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <line x1="15.5" y1="15.5" x2="21" y2="21" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
          <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
          <line x1="8" y1="3" x2="8" y2="6.5" />
          <line x1="16" y1="3" x2="16" y2="6.5" />
        </svg>
      );
    case "support":
      return (
        <svg {...common}>
          <path d="M12 21s-7-4.3-7-9.4A4.6 4.6 0 0112 8.4 4.6 4.6 0 0119 11.6C19 16.7 12 21 12 21z" />
        </svg>
      );
  }
}

/** Example prompts for the AI planner promo (approachable, not technical). */
const PLANNER_PROMPTS: string[] = [
  "A relaxed 4-day Goa trip for two",
  "A week of food and temples in Kyoto",
  "A budget island escape in the Philippines",
  "A long weekend of art and cafes in Paris",
];

const RECENT_KEY = "tripgenie:recently-viewed";

interface RecentItem {
  label: string;
  href: string;
}

/** Read recently-viewed items from browser-local storage; total + safe. */
function readRecent(): RecentItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x.label === "string" && typeof x.href === "string")
      .slice(0, 6);
  } catch {
    return [];
  }
}

/** A small labelled field-error line; rendered only when a message exists. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span id={id} className="field-error" role="alert">
      {message}
    </span>
  );
}

export default function Homepage({ showHero = true }: { showHero?: boolean } = {}) {
  const router = useRouter();
  const [active, setActive] = useState<BookingTab>("stays");

  // Recently viewed / saved (continue-exploring) — browser-local, read on mount.
  const [recent, setRecent] = useState<RecentItem[]>([]);
  useEffect(() => {
    setRecent(readRecent());
  }, []);

  // ---- Stays form state ----------------------------------------------------
  const [stays, setStays] = useState<Partial<StaysCriteria>>({
    destination: "",
    checkIn: "",
    checkOut: "",
    guests: 2,
    rooms: 1,
  });
  const [staysErrors, setStaysErrors] = useState<Record<string, string>>({});

  // ---- Flights form state --------------------------------------------------
  const [flights, setFlights] = useState<Partial<FlightsCriteria>>({
    tripType: "round-trip",
    origin: "",
    destination: "",
    departDate: "",
    returnDate: "",
    travellers: 1,
    cabin: "economy",
  });
  const [flightsErrors, setFlightsErrors] = useState<Record<string, string>>({});

  // ---- Cars form state -----------------------------------------------------
  const [cars, setCars] = useState<Partial<CarsCriteria>>({
    pickupLocation: "",
    dropoffLocation: "",
    pickupDate: "",
    pickupTime: "",
    returnDate: "",
    returnTime: "",
    driverAge: 25,
  });
  const [carsDifferentDropoff, setCarsDifferentDropoff] = useState(false);
  const [carsErrors, setCarsErrors] = useState<Record<string, string>>({});

  // ---- AI planning prompt --------------------------------------------------
  const [aiPrompt, setAiPrompt] = useState("");

  // ---- "I'm flexible with dates" (visual preference; does not alter submit) --
  const [flexibleDates, setFlexibleDates] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  /** Populate the active form's destination from a discovery/popular selection. */
  function selectDestination(name: string) {
    if (active === "stays") setStays((s) => ({ ...s, destination: name }));
    else if (active === "flights") setFlights((f) => ({ ...f, destination: name }));
    else setCars((c) => ({ ...c, pickupLocation: name }));
  }

  function submitStays(e: React.FormEvent) {
    e.preventDefault();
    // Prevent a duplicate submission while one is already in progress (Req 28.5).
    if (submitting) return;
    const errors = validateStays(stays);
    setStaysErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const criteria: StaysCriteria = {
      category: "stays",
      destination: stays.destination as string,
      checkIn: stays.checkIn as string,
      checkOut: stays.checkOut as string,
      guests: stays.guests as number,
      rooms: stays.rooms as number,
    };
    setSubmitting(true);
    router.push(`/stays?${serializeCriteria(criteria)}`);
  }

  function submitFlights(e: React.FormEvent) {
    e.preventDefault();
    // Prevent a duplicate submission while one is already in progress (Req 28.5).
    if (submitting) return;
    const isRound = flights.tripType === "round-trip";
    const errors = validateFlights(flights);
    setFlightsErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const criteria: FlightsCriteria = {
      category: "flights",
      tripType: flights.tripType as FlightTripType,
      origin: flights.origin as string,
      destination: flights.destination as string,
      departDate: flights.departDate as string,
      travellers: flights.travellers as number,
      cabin: flights.cabin as string,
      ...(isRound ? { returnDate: flights.returnDate as string } : {}),
    };
    setSubmitting(true);
    router.push(`/flights?${serializeCriteria(criteria)}`);
  }

  function swapFlights() {
    setFlights((f) => ({ ...f, origin: f.destination ?? "", destination: f.origin ?? "" }));
  }

  function submitCars(e: React.FormEvent) {
    e.preventDefault();
    // Prevent a duplicate submission while one is already in progress (Req 28.5).
    if (submitting) return;
    // When drop-off is the same as pickup, carry no separate dropoffLocation.
    const fields: Partial<CarsCriteria> = {
      ...cars,
      dropoffLocation: carsDifferentDropoff ? cars.dropoffLocation : cars.pickupLocation,
    };
    const errors = validateCars(fields);
    setCarsErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const criteria: CarsCriteria = {
      category: "cars",
      pickupLocation: cars.pickupLocation as string,
      pickupDate: cars.pickupDate as string,
      pickupTime: cars.pickupTime as string,
      returnDate: cars.returnDate as string,
      returnTime: cars.returnTime as string,
      driverAge: cars.driverAge as number,
      // dropoffLocation is present iff a different drop-off was requested (Req 25.2).
      ...(carsDifferentDropoff && cars.dropoffLocation
        ? { dropoffLocation: cars.dropoffLocation as string }
        : {}),
    };
    setSubmitting(true);
    router.push(`/cars?${serializeCriteria(criteria)}`);
  }

  function submitAiPrompt(e: React.FormEvent) {
    e.preventDefault();
    const q = aiPrompt.trim();
    if (!q) return;
    router.push(`/plan?q=${encodeURIComponent(q)}`);
  }

  const isRoundTrip = flights.tripType === "round-trip";

  const popular = useMemo(() => POPULAR_DESTINATIONS, []);

  return (
    <main className="home">
      {/*
        ── 1. HERO — asymmetric two-column white layout (Req 5.1–5.4) ─────
        Gated behind `showHero` (Req 21.2): when Homepage is rendered as a
        secondary section under the AI concierge on `/`, the concierge is the
        sole lead hero, so this inline hero + tabbed trip-finder is suppressed.
        The code is preserved (not deleted) so Homepage still works standalone
        with its full search submit/validation/navigation when `showHero` is
        true. The tab-search submit paths remain reachable via Global_Navigation
        (/stays, /flights, /cars) and the concierge (/plan).
      */}
      {showHero && (
      <section className="home-hero home-hero2" aria-label="TripGenie">
        <div className="home-hero__inner shell">
          <div className="home-hero2__grid grid-2">
            {/* LEFT: serif heading + paragraph + compact trip-finder form. */}
            <div className="home-hero2__col home-hero2__col--content motion-rise">
              <div className="home-hero__copy home-hero2__copy">
                <h1 className="display home-hero__title">Your intelligent travel companion.</h1>
                <p className="home-hero__sub">
                  TripGenie AI discovers destinations, compares stays, flights and
                  cars, and plans full itineraries for you — so every journey comes
                  together in one place.
                </p>
              </div>

              <div className="home-search trip-finder" aria-label="Search travel">
          <div className="tablist" role="tablist" aria-label="Booking categories">
            {TABS.map((t) => {
              const selected = active === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={`tab tab-pill${selected ? " tab-active" : ""}`}
                  onClick={() => setActive(t.id)}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Stays form */}
          {active === "stays" && (
            <form
              id="panel-stays"
              role="tabpanel"
              aria-labelledby="tab-stays"
              className="search-form search-row"
              onSubmit={submitStays}
              noValidate
            >
              <label className="field">
                <span>Destination</span>
                <input
                  type="text"
                  value={stays.destination ?? ""}
                  aria-invalid={!!staysErrors.destination}
                  aria-describedby="err-stays-destination"
                  onChange={(e) => setStays({ ...stays, destination: e.target.value })}
                  placeholder="Where to?"
                />
                <FieldError id="err-stays-destination" message={staysErrors.destination} />
              </label>
              <label className="field">
                <span>Check-in</span>
                <input
                  type="date"
                  value={stays.checkIn ?? ""}
                  aria-invalid={!!staysErrors.checkIn}
                  aria-describedby="err-stays-checkin"
                  onChange={(e) => setStays({ ...stays, checkIn: e.target.value })}
                />
                <FieldError id="err-stays-checkin" message={staysErrors.checkIn} />
              </label>
              <label className="field">
                <span>Check-out</span>
                <input
                  type="date"
                  value={stays.checkOut ?? ""}
                  aria-invalid={!!staysErrors.checkOut}
                  aria-describedby="err-stays-checkout"
                  onChange={(e) => setStays({ ...stays, checkOut: e.target.value })}
                />
                <FieldError id="err-stays-checkout" message={staysErrors.checkOut} />
              </label>
              <label className="field">
                <span>Guests</span>
                <input
                  type="number"
                  min={1}
                  value={stays.guests ?? 1}
                  aria-invalid={!!staysErrors.guests}
                  onChange={(e) => setStays({ ...stays, guests: Number(e.target.value) })}
                />
                <FieldError id="err-stays-guests" message={staysErrors.guests} />
              </label>
              <button className="cta search-cta" type="submit" disabled={submitting}>
                <SearchGlyph /> Search
              </button>
            </form>
          )}

          {/* Flights form */}
          {active === "flights" && (
            <form
              id="panel-flights"
              role="tabpanel"
              aria-labelledby="tab-flights"
              className="search-form"
              onSubmit={submitFlights}
              noValidate
            >
              <fieldset className="triptype">
                <legend>Trip type</legend>
                <label className="radio">
                  <input
                    type="radio"
                    name="tripType"
                    checked={flights.tripType === "round-trip"}
                    onChange={() => setFlights({ ...flights, tripType: "round-trip" })}
                  />
                  Round-trip
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="tripType"
                    checked={flights.tripType === "one-way"}
                    onChange={() => setFlights({ ...flights, tripType: "one-way" })}
                  />
                  One-way
                </label>
              </fieldset>
              <div className="search-row">
                <label className="field">
                  <span>Origin</span>
                  <input
                    type="text"
                    value={flights.origin ?? ""}
                    aria-invalid={!!flightsErrors.origin}
                    aria-describedby="err-flights-origin"
                    onChange={(e) => setFlights({ ...flights, origin: e.target.value })}
                    placeholder="From"
                  />
                  <FieldError id="err-flights-origin" message={flightsErrors.origin} />
                </label>
                <button
                  type="button"
                  className="swap-btn"
                  onClick={swapFlights}
                  aria-label="Swap origin and destination"
                  title="Swap origin and destination"
                >
                  {"\u21C4"}
                </button>
                <label className="field">
                  <span>Destination</span>
                  <input
                    type="text"
                    value={flights.destination ?? ""}
                    aria-invalid={!!flightsErrors.destination}
                    aria-describedby="err-flights-destination"
                    onChange={(e) => setFlights({ ...flights, destination: e.target.value })}
                    placeholder="To"
                  />
                  <FieldError id="err-flights-destination" message={flightsErrors.destination} />
                </label>
                <label className="field">
                  <span>Depart</span>
                  <input
                    type="date"
                    value={flights.departDate ?? ""}
                    aria-invalid={!!flightsErrors.departDate}
                    aria-describedby="err-flights-depart"
                    onChange={(e) => setFlights({ ...flights, departDate: e.target.value })}
                  />
                  <FieldError id="err-flights-depart" message={flightsErrors.departDate} />
                </label>
                {isRoundTrip && (
                  <label className="field">
                    <span>Return</span>
                    <input
                      type="date"
                      value={flights.returnDate ?? ""}
                      aria-invalid={!!flightsErrors.returnDate}
                      aria-describedby="err-flights-return"
                      onChange={(e) => setFlights({ ...flights, returnDate: e.target.value })}
                    />
                    <FieldError id="err-flights-return" message={flightsErrors.returnDate} />
                  </label>
                )}
                <label className="field">
                  <span>Travellers</span>
                  <input
                    type="number"
                    min={1}
                    value={flights.travellers ?? 1}
                    aria-invalid={!!flightsErrors.travellers}
                    onChange={(e) => setFlights({ ...flights, travellers: Number(e.target.value) })}
                  />
                  <FieldError id="err-flights-travellers" message={flightsErrors.travellers} />
                </label>
                <label className="field">
                  <span>Cabin</span>
                  <select
                    value={flights.cabin ?? "economy"}
                    aria-invalid={!!flightsErrors.cabin}
                    onChange={(e) => setFlights({ ...flights, cabin: e.target.value })}
                  >
                    <option value="economy">Economy</option>
                    <option value="premium">Premium economy</option>
                    <option value="business">Business</option>
                    <option value="first">First</option>
                  </select>
                  <FieldError id="err-flights-cabin" message={flightsErrors.cabin} />
                </label>
                <button className="cta search-cta" type="submit" disabled={submitting}>
                  <SearchGlyph /> Search
                </button>
              </div>
            </form>
          )}

          {/* Cars form */}
          {active === "cars" && (
            <form
              id="panel-cars"
              role="tabpanel"
              aria-labelledby="tab-cars"
              className="search-form"
              onSubmit={submitCars}
              noValidate
            >
              <div className="search-row">
                <label className="field">
                  <span>Pickup location</span>
                  <input
                    type="text"
                    value={cars.pickupLocation ?? ""}
                    aria-invalid={!!carsErrors.pickupLocation}
                    aria-describedby="err-cars-pickup"
                    onChange={(e) => setCars({ ...cars, pickupLocation: e.target.value })}
                    placeholder="City or airport"
                  />
                  <FieldError id="err-cars-pickup" message={carsErrors.pickupLocation} />
                </label>
                {carsDifferentDropoff && (
                  <label className="field">
                    <span>Drop-off location</span>
                    <input
                      type="text"
                      value={cars.dropoffLocation ?? ""}
                      onChange={(e) => setCars({ ...cars, dropoffLocation: e.target.value })}
                      placeholder="Drop-off city or airport"
                    />
                  </label>
                )}
                <label className="field">
                  <span>Pickup date</span>
                  <input
                    type="date"
                    value={cars.pickupDate ?? ""}
                    aria-invalid={!!carsErrors.pickupDate}
                    aria-describedby="err-cars-pickup-date"
                    onChange={(e) => setCars({ ...cars, pickupDate: e.target.value })}
                  />
                  <FieldError id="err-cars-pickup-date" message={carsErrors.pickupDate} />
                </label>
                <label className="field">
                  <span>Pickup time</span>
                  <input
                    type="time"
                    value={cars.pickupTime ?? ""}
                    aria-invalid={!!carsErrors.pickupTime}
                    aria-describedby="err-cars-pickup-time"
                    onChange={(e) => setCars({ ...cars, pickupTime: e.target.value })}
                  />
                  <FieldError id="err-cars-pickup-time" message={carsErrors.pickupTime} />
                </label>
                <label className="field">
                  <span>Return date</span>
                  <input
                    type="date"
                    value={cars.returnDate ?? ""}
                    aria-invalid={!!carsErrors.returnDate}
                    aria-describedby="err-cars-return-date"
                    onChange={(e) => setCars({ ...cars, returnDate: e.target.value })}
                  />
                  <FieldError id="err-cars-return-date" message={carsErrors.returnDate} />
                </label>
                <label className="field">
                  <span>Return time</span>
                  <input
                    type="time"
                    value={cars.returnTime ?? ""}
                    aria-invalid={!!carsErrors.returnTime}
                    aria-describedby="err-cars-return-time"
                    onChange={(e) => setCars({ ...cars, returnTime: e.target.value })}
                  />
                  <FieldError id="err-cars-return-time" message={carsErrors.returnTime} />
                </label>
                <label className="field age-field">
                  <span>Driver age</span>
                  <input
                    type="number"
                    min={18}
                    value={cars.driverAge ?? 18}
                    aria-invalid={!!carsErrors.driverAge}
                    aria-describedby="err-cars-age"
                    onChange={(e) => setCars({ ...cars, driverAge: Number(e.target.value) })}
                  />
                  <FieldError id="err-cars-age" message={carsErrors.driverAge} />
                </label>
                <button className="cta search-cta" type="submit" disabled={submitting}>
                  <SearchGlyph /> Search
                </button>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={carsDifferentDropoff}
                  onChange={(e) => setCarsDifferentDropoff(e.target.checked)}
                />
                Return to a different location
              </label>
            </form>
          )}

          <div className="home-search__footrow">
            <label className="checkbox home-search__flex">
              <input
                type="checkbox"
                checked={flexibleDates}
                onChange={(e) => setFlexibleDates(e.target.checked)}
              />
              I&apos;m flexible with dates
            </label>
            <form className="home-search__ai" onSubmit={submitAiPrompt}>
              <label className="sr-only" htmlFor="home-ai-input">
                Describe your trip for AI recommendations
              </label>
              <input
                id="home-ai-input"
                type="text"
                className="home-search__ai-input"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder="A relaxed 4-day Goa trip for two"
                aria-label="Describe your trip for AI recommendations"
              />
              <button type="submit" className="home-search__ai-link">
                Search with AI — Get personalized recommendations
              </button>
            </form>
          </div>
              </div>
            </div>

            {/* RIGHT: large original green travel illustration (orange accents). */}
            <div className="home-hero2__col home-hero2__col--art" aria-hidden="true">
              {(() => {
                const art = illustration("traveler-globe");
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="illustration home-hero2__art"
                    src={art.src}
                    width={art.width}
                    height={art.height}
                    alt={art.alt}
                  />
                );
              })()}
            </div>
          </div>
        </div>
      </section>
      )}

      {/* ── 2. FEATURED EXPLORATION — asymmetric illustration + text (Req 5.5) ── */}
      <section className="shell home-feature-explore" aria-labelledby="explore-heading">
        <div className="home-feature-explore__grid grid-2">
          <div className="home-feature-explore__art" aria-hidden="true">
            {(() => {
              const art = illustration("winding-path");
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="illustration home-feature-explore__img"
                  src={art.src}
                  width={art.width}
                  height={art.height}
                  alt={art.alt}
                />
              );
            })()}
          </div>
          <div className="home-feature-explore__copy motion-rise">
            <h2 id="explore-heading" className="section-title">A new way to explore the world</h2>
            <p className="section-sub">
              TripGenie AI learns what you love — the pace, the places, the little
              detours — and turns it into a journey that feels made for you. Discover
              fresh destinations and shape a personalized plan without the busywork.
            </p>
            <a className="cta home-feature-explore__cta" href="/plan">
              Start exploring {"\u2192"}
            </a>
          </div>
        </div>
      </section>

      {/* ── 4. POPULAR DESTINATIONS ───────────────────────────────────────── */}
      <section className="shell home-section" aria-labelledby="popular-heading">
        <header className="section-head">
          <div>
            <h2 id="popular-heading" className="section-title">Popular destinations</h2>
            <p className="section-sub">Explore handpicked destinations for your next adventure</p>
          </div>
          <a className="section-link" href="/stays">View all {"\u2192"}</a>
        </header>
        <div className="dest-rail" role="list">
          {popular.map((d, i) => (
            <button
              key={d.name}
              type="button"
              role="listitem"
              className="dest-card"
              onClick={() => selectDestination(d.name)}
              aria-label={`Choose ${d.name}, ${d.country}`}
            >
              <DestinationImageLayer query={d.name} slot={i} />
              <span className="dest-card__scrim" aria-hidden="true" />
              <span className="dest-card__meta">
                <span className="dest-card__name">{d.name}</span>
                <span className="dest-card__country">{d.country}</span>
                <span className="dest-card__blurb">{d.blurb}</span>
                <span className="dest-card__tag">Popular now</span>
              </span>
              <span className="dest-card__go" aria-hidden="true">{"\u2192"}</span>
            </button>
          ))}
        </div>
      </section>

      {/* ── 7. FEATURE ICONS ROW ──────────────────────────────────────────── */}
      <section className="shell home-features" aria-label="Why TripGenie">
        <ul className="feature-row">
          {FEATURES.map((f) => (
            <li key={f.title} className="feature">
              <span className="feature__icon" aria-hidden="true">
                <FeatureGlyph name={f.icon} />
              </span>
              <h3 className="feature__title">{f.title}</h3>
              <p className="feature__copy">{f.copy}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 8. AI PLANNER PROMO — heading + copy + example prompts (Req 5.7) ── */}
      <section className="shell home-planner-promo" aria-labelledby="planner-promo-heading">
        <div className="home-planner-promo__inner">
          <h2 id="planner-promo-heading" className="section-title">Plan it with a sentence</h2>
          <p className="section-sub">
            Tell TripGenie AI the trip you are dreaming about and watch a day-by-day
            plan take shape. No forms, no tabs — just describe it in your own words.
          </p>
          <ul className="home-prompt-chips" aria-label="Example prompts">
            {PLANNER_PROMPTS.map((p) => (
              <li key={p}>
                <a
                  className="home-prompt-chip"
                  href={`/plan?q=${encodeURIComponent(p)}`}
                >
                  {p}
                </a>
              </li>
            ))}
          </ul>
          <a className="cta home-planner-promo__cta" href="/plan">
            Plan with TripGenie AI {"\u2192"}
          </a>
        </div>
      </section>

      {/* Continue exploring: recently viewed/saved, else empty state (Req 22.9/22.10) */}
      <section className="shell home-section" aria-labelledby="continue-heading">
        <h2 id="continue-heading" className="section-title">Continue exploring</h2>
        {recent.length > 0 ? (
          <ul className="recent-list">
            {recent.map((item, i) => (
              <li key={`${item.href}-${i}`}>
                <a className="recent-link booking-surface" href={item.href}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className="booking-surface empty-state">
            <p>You have not viewed or saved anything yet.</p>
            <p>Start a search above to pick up where you leave off.</p>
            <button type="button" className="cta" onClick={() => setActive("stays")}>
              Start a search
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
