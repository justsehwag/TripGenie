"use client";

/**
 * Stays search form for the /stays page.
 *
 * Lets the traveller run a live hotel search straight from /stays (destination,
 * dates, guests, rooms) instead of having to arrive with a pre-built URL. It
 * validates with the shared `validateStays` rules, blocks past check-in dates,
 * and navigates to `/stays?<criteria>` so the server page runs ONE live search.
 * Optional view params (sort, stay style) are carried over unchanged.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { serializeCriteria, validateStays, type StaysCriteria } from "@/lib/search-criteria";

export interface StaysSearchFormProps {
  /** Today's date (YYYY-MM-DD, IST) computed on the server; earliest check-in. */
  today: string;
  initial?: Partial<Pick<StaysCriteria, "destination" | "checkIn" | "checkOut" | "guests" | "rooms">>;
  /** Extra view params to keep (e.g. sort, stayStyle). */
  keep?: Record<string, string>;
  /** Compact = shown above results; full = empty state. */
  compact?: boolean;
}

/** Add `days` to a YYYY-MM-DD date (UTC arithmetic, no timezone drift). */
function addDays(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return "";
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

export default function StaysSearchForm({ today, initial, keep, compact }: StaysSearchFormProps) {
  const router = useRouter();
  const [destination, setDestination] = useState(initial?.destination ?? "");
  const [checkIn, setCheckIn] = useState(initial?.checkIn ?? "");
  const [checkOut, setCheckOut] = useState(initial?.checkOut ?? "");
  const [guests, setGuests] = useState(String(initial?.guests ?? 2));
  const [rooms, setRooms] = useState(String(initial?.rooms ?? 1));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const g = Number.parseInt(guests, 10);
    const r = Number.parseInt(rooms, 10);
    const found = validateStays({
      destination: destination.trim(),
      checkIn,
      checkOut,
      guests: Number.isFinite(g) ? g : undefined,
      rooms: Number.isFinite(r) ? r : undefined,
    });
    if (!found.checkIn && checkIn && checkIn < today) found.checkIn = "Check-in can't be in the past.";
    if (!found.guests && (g < 1 || g > 9)) found.guests = "Guests must be between 1 and 9.";
    if (!found.rooms && (r < 1 || r > 9)) found.rooms = "Rooms must be between 1 and 9.";
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const criteria: StaysCriteria = {
      category: "stays",
      destination: destination.trim(),
      checkIn,
      checkOut,
      guests: g,
      rooms: r,
    };
    const params = new URLSearchParams(serializeCriteria(criteria));
    for (const [k, v] of Object.entries(keep ?? {})) if (v) params.set(k, v);
    setSubmitting(true);
    router.push(`/stays?${params.toString()}`);
  }

  // Reset the submitting flag when the user edits after navigating back.
  function edit<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      if (submitting) setSubmitting(false);
    };
  }

  const minCheckOut = checkIn ? addDays(checkIn, 1) : addDays(today, 1);

  return (
    <form
      className={`card stays-search${compact ? " stays-search--compact" : ""}`}
      onSubmit={submit}
      noValidate
      aria-label="Search stays"
    >
      {!compact && (
        <div className="stays-search__intro">
          <h2>Find a stay with live prices</h2>
          <p>Real rates from hotel sites for your exact dates. Book directly on the site you choose.</p>
        </div>
      )}
      <div className="stays-search__fields">
        <label className="field stays-search__destination">
          <span>Destination</span>
          <input
            type="text"
            name="destination"
            placeholder="City or area, e.g. Goa"
            autoComplete="off"
            value={destination}
            aria-invalid={!!errors.destination}
            aria-describedby={errors.destination ? "stays-err-destination" : undefined}
            onChange={(e) => edit(setDestination)(e.target.value)}
          />
          {errors.destination && <small id="stays-err-destination" className="field-error">{errors.destination}</small>}
        </label>
        <label className="field">
          <span>Check-in</span>
          <input
            type="date"
            name="checkIn"
            min={today}
            value={checkIn}
            aria-invalid={!!errors.checkIn}
            aria-describedby={errors.checkIn ? "stays-err-checkin" : undefined}
            onChange={(e) => {
              const v = e.target.value;
              edit(setCheckIn)(v);
              if (v && (!checkOut || checkOut <= v)) setCheckOut(addDays(v, 1));
            }}
          />
          {errors.checkIn && <small id="stays-err-checkin" className="field-error">{errors.checkIn}</small>}
        </label>
        <label className="field">
          <span>Check-out</span>
          <input
            type="date"
            name="checkOut"
            min={minCheckOut}
            value={checkOut}
            aria-invalid={!!errors.checkOut}
            aria-describedby={errors.checkOut ? "stays-err-checkout" : undefined}
            onChange={(e) => edit(setCheckOut)(e.target.value)}
          />
          {errors.checkOut && <small id="stays-err-checkout" className="field-error">{errors.checkOut}</small>}
        </label>
        <label className="field stays-search__count">
          <span>Guests</span>
          <input
            type="number"
            name="guests"
            min={1}
            max={9}
            inputMode="numeric"
            value={guests}
            aria-invalid={!!errors.guests}
            aria-describedby={errors.guests ? "stays-err-guests" : undefined}
            onChange={(e) => edit(setGuests)(e.target.value)}
          />
          {errors.guests && <small id="stays-err-guests" className="field-error">{errors.guests}</small>}
        </label>
        <label className="field stays-search__count">
          <span>Rooms</span>
          <input
            type="number"
            name="rooms"
            min={1}
            max={9}
            inputMode="numeric"
            value={rooms}
            aria-invalid={!!errors.rooms}
            aria-describedby={errors.rooms ? "stays-err-rooms" : undefined}
            onChange={(e) => edit(setRooms)(e.target.value)}
          />
          {errors.rooms && <small id="stays-err-rooms" className="field-error">{errors.rooms}</small>}
        </label>
        <button type="submit" className="cta stays-search__submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? "Searching\u2026" : compact ? "Update search" : "Search stays"}
        </button>
      </div>
    </form>
  );
}