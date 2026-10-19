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
 * Also renders: a destination discovery section that populates the active form's
 * destination (Req 22.3/22.4), a sign-in-for-savings promo (Req 22.5), an AI
 * planning prompt entry routing to /plan?q=... (Req 22.6/22.7), a popular
 * destinations section (Req 22.8), and a continue-exploring section backed by
 * browser-local recently-viewed with a clean empty state (Req 22.9/22.10).
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

type BookingTab = "stays" | "flights" | "cars";

const TABS: { id: BookingTab; label: string }[] = [
  { id: "stays", label: "Stays" },
  { id: "flights", label: "Flights" },
  { id: "cars", label: "Cars" },
];

/** Editorial destination set reused for discovery + populate-on-select. */
const DISCOVERY = [
  { name: "Goa", blurb: "Slow coastal mornings and sunset drives." },
  { name: "Udaipur", blurb: "Lake palaces and old-city lanes." },
  { name: "Kyoto", blurb: "Temple gardens and quiet tea houses." },
  { name: "Lisbon", blurb: "Tiled hills and Atlantic light." },
];

const POPULAR = ["Goa", "Jaipur", "Bali", "Paris", "Tokyo", "Dubai", "Singapore", "Rome"];

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

export default function Homepage() {
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

  const popular = useMemo(() => POPULAR, []);

  return (
    <main className="shell home">
      {/* Hero — editorial, glass-accent proportion preserved from the old landing */}
      <section className="motion-rise home-hero">
        <p className="eyebrow">AWS-native travel concierge</p>
        <h1 className="display">Find the trip. Book it calm.</h1>
        <p className="lead">
          Search stays, flights, and cars from one warm, editorial home — then let
          the planner turn a sentence into a day-by-day itinerary.
        </p>
      </section>

      {/* Booking panel: tabs + the active search form (opaque, fully legible) */}
      <section className="booking-surface home-panel motion-rise" aria-label="Search travel">
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
                className={`tab${selected ? " tab-active" : ""}`}
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
            className="search-form"
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
            <div className="field-row">
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
            </div>
            <div className="field-row">
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
              <label className="field">
                <span>Rooms</span>
                <input
                  type="number"
                  min={1}
                  value={stays.rooms ?? 1}
                  aria-invalid={!!staysErrors.rooms}
                  onChange={(e) => setStays({ ...stays, rooms: Number(e.target.value) })}
                />
                <FieldError id="err-stays-rooms" message={staysErrors.rooms} />
              </label>
            </div>
            <button className="cta" type="submit" disabled={submitting}>
              Search stays
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
            <div className="field-row swap-row">
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
                ⇄
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
            </div>
            <div className="field-row">
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
            </div>
            <div className="field-row">
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
            </div>
            <button className="cta" type="submit" disabled={submitting}>
              Search flights
            </button>
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
            <label className="checkbox">
              <input
                type="checkbox"
                checked={carsDifferentDropoff}
                onChange={(e) => setCarsDifferentDropoff(e.target.checked)}
              />
              Return to a different location
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
            <div className="field-row">
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
            </div>
            <div className="field-row">
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
            </div>
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
            <button className="cta" type="submit" disabled={submitting}>
              Search cars
            </button>
          </form>
        )}
      </section>

      {/* AI planning prompt entry (Req 22.6/22.7) */}
      <section className="glass home-ai motion-rise" aria-label="AI travel assistant">
        <h2>Describe your trip</h2>
        <p>Tell the planner in a sentence and we will draft a day-by-day itinerary.</p>
        <form className="ai-form" onSubmit={submitAiPrompt}>
          <label className="field ai-field">
            <span className="sr-only">Trip request</span>
            <input
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="A relaxed 4-day Goa trip from Delhi for two"
              aria-label="Trip request"
            />
          </label>
          <button className="cta" type="submit">
            Plan with AI
          </button>
        </form>
      </section>

      {/* Destination discovery (selectable → populates active form) (Req 22.3/22.4) */}
      <section className="home-section" aria-labelledby="discovery-heading">
        <h2 id="discovery-heading">Discover a destination</h2>
        <div className="card-grid">
          {DISCOVERY.map((d) => (
            <button
              key={d.name}
              type="button"
              className="glass discovery-card"
              onClick={() => selectDestination(d.name)}
            >
              <h3>{d.name}</h3>
              <p>{d.blurb}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Sign-in-for-savings promo (Req 22.5) */}
      <section className="glass home-promo motion-rise" aria-labelledby="promo-heading">
        <h2 id="promo-heading">Sign in for savings</h2>
        <p>
          Members unlock better prices and keep every trip in one place. Sign in to
          start saving.
        </p>
        <a className="cta" href="/">
          Sign in for savings
        </a>
      </section>

      {/* Popular destinations (selectable) (Req 22.8) */}
      <section className="home-section" aria-labelledby="popular-heading">
        <h2 id="popular-heading">Popular destinations</h2>
        <div className="chip-row">
          {popular.map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              onClick={() => selectDestination(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </section>

      {/* Continue exploring: recently viewed/saved, else empty state (Req 22.9/22.10) */}
      <section className="home-section" aria-labelledby="continue-heading">
        <h2 id="continue-heading">Continue exploring</h2>
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
