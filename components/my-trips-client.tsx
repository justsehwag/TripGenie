"use client";

/**
 * My_Trips_Page client (Task 35.2) — design section
 * "Booking Site (Hopper-style Multi-page Experience) → My_Trips_Page (Req 27)".
 *
 * Binds to the `Trip_Store` through the owner-scoped trips API at `/api/trips`,
 * which wraps `lib/dynamo-store` (`listNewest` → newest-five retention, Req 13 /
 * Property 32) over the pure `lib/trip-retention` core. Nothing here invents a
 * persistence layer: loads are `GET /api/trips?owner=…`, edits are the same
 * idempotent `POST /api/trips` the Planner uses (keyed on `clientDraftId`,
 * Property 31), and deletes call the owner-scoped trips API.
 *
 * Session source (signed-in vs anonymous). There is NO live Cognito session
 * wired into the Booking_Site yet (the root layout documents this: its chrome
 * session starts `null`). So the signed-in state is driven from a single,
 * clearly-commented browser-local session source — `readSession()` below —
 * rather than invented credentials. When a real hosted-UI session is wired, that
 * one function is the only thing that changes; everything downstream already
 * keys off the resolved stable `userId` (Req 13).
 *
 * Behaviour:
 *   • Anonymous → a sign-in prompt reusing the Req 1 Identity_Provider entry and
 *     NO other traveler's trips (Req 27.1).
 *   • Signed-in → the traveler's five newest saved trips scoped to the stable
 *     user id (Req 27.2); an empty state inviting a search or the Planner when
 *     there are none (Req 27.3).
 *   • View a saved trip (Req 27.4); edit it (Req 27.5) and delete it (Req 27.6)
 *     — owner-scoped against the Trip_Store.
 *   • Resume an unfinished trip → navigate to `/plan` with the trip's
 *     `Trip_Context` restored via a `?trip=` query parameter (Req 27.7).
 *   • Confirmed bookings are shown SEPARATELY from self-created itineraries,
 *     with a visible distinction, keyed on the stored `status` (Req 27.8).
 *   • The Site_Footer is rendered by the layout (Req 27.9) — not added here.
 *
 * Surfaces use the minimalist Design_System tokens (ui-redesign Req 13): clean
 * white `card` surfaces for each trip / booking card, a light `card` for the
 * sign-in / empty invitations, and `motion-rise` for the one-time entrance
 * motion. The itinerary-vs-booking distinction is carried as a light accent
 * (a left border + badge), not a heavy treatment. Layout stays single-column
 * and overflow-free at ≥320px.
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import AuthLanding from "@/components/auth-landing";
import { illustration } from "@/lib/illustrations";
import type { IdentityProviderPolicy, IdentitySession } from "@/lib/identity";
import type { StoredTrip } from "@/lib/trip-retention";

/** A single restrained header accent reused across the page states (Req 13.1). */
const HEADER_ILLUSTRATION = illustration("suitcase");

/**
 * The one browser-local key the stubbed session source reads. A real hosted-UI
 * integration (Req 1) would populate this — or replace `readSession()` entirely
 * — with the Cognito-resolved identity. Until then it is the single documented
 * seam between "anonymous" and "signed-in", so no credentials are fabricated.
 */
const SESSION_KEY = "tripgenie.session";

/** Resolve the current session from the browser-local stub source (see above). */
function readSession(): IdentitySession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IdentitySession>;
    // A session is only usable when it carries a stable user id (Req 13).
    if (parsed && typeof parsed.userId === "string" && parsed.userId.trim()) {
      return {
        userId: parsed.userId.trim(),
        firstName: typeof parsed.firstName === "string" ? parsed.firstName : undefined,
        email: typeof parsed.email === "string" ? parsed.email : undefined,
      };
    }
  } catch {
    // A corrupt stub is treated as anonymous, never as another traveler.
  }
  return null;
}

/** A trip whose stored status marks it a confirmed booking (Req 27.8). */
function isConfirmedBooking(trip: StoredTrip): boolean {
  return trip.status.trim().toLowerCase() === "confirmed";
}

/** A trip that is still in progress and can be resumed in the Planner (Req 27.7). */
function isResumable(trip: StoredTrip): boolean {
  const s = trip.status.trim().toLowerCase();
  return s === "draft" || s === "in-progress" || s === "planning";
}

/**
 * Booking details "when available" (Req 7.8). The Trip_Store strips sensitive
 * keys before persisting (`stripSensitive`, Req 13.6), so whatever confirmation
 * fields survive into `payload` are safe to surface. We read ONLY the known
 * non-sensitive confirmation fields that are actually present in the stored
 * payload — we never fabricate booking data. When none exist we return null and
 * the card shows nothing extra.
 */
function bookingDetails(trip: StoredTrip): string | null {
  const payload = trip.payload ?? {};
  // A confirmation may be stored either flat on the payload or under a nested
  // `booking` object; read both, flat keys taking precedence.
  const nested =
    payload.booking !== null &&
    typeof payload.booking === "object" &&
    !Array.isArray(payload.booking)
      ? (payload.booking as Record<string, unknown>)
      : {};
  const source: Record<string, unknown> = { ...nested, ...payload };

  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return null;
  };

  const parts: string[] = [];
  const reference = pick("confirmationNumber", "confirmation", "bookingReference", "reference", "orderId");
  if (reference) parts.push(`Confirmation ${reference}`);
  const provider = pick("provider", "supplier", "airline", "hotel");
  if (provider) parts.push(provider);
  const total = pick("total", "totalPrice", "amount");
  if (total) parts.push(/^[^0-9]/.test(total) ? total : `Total ${total}`);

  return parts.length > 0 ? parts.join(" · ") : null;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; trips: StoredTrip[] };

export interface MyTripsClientProps {
  /** Enabled-provider policy, reused from Req 1; drives the sign-in prompt (Req 27.1 / 29.5). */
  providerPolicy: IdentityProviderPolicy;
  /**
   * Optional session override, injected by tests so signed-in vs anonymous can
   * be asserted without touching browser-local storage. Defaults to the
   * browser-local stub source via `readSession()`.
   */
  session?: IdentitySession | null;
}

export default function MyTripsClient({ providerPolicy, session }: MyTripsClientProps) {
  // Resolve the session once on mount from the stub source, unless a test
  // injected one. `undefined` means "not resolved yet" (server render / first
  // paint); `null` means "resolved and anonymous".
  const [resolved, setResolved] = useState<IdentitySession | null | undefined>(
    session,
  );
  useEffect(() => {
    if (session === undefined) setResolved(readSession());
  }, [session]);

  const owner = resolved?.userId ?? null;
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const loadTrips = useCallback(async (ownerId: string) => {
    setLoad({ phase: "loading" });
    try {
      // The API scopes to this owner and returns only the newest five
      // (`listNewest`), so no other traveler's trips can appear (Req 27.1/27.2).
      const res = await fetch(`/api/trips?owner=${encodeURIComponent(ownerId)}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Request failed (${res.status}).`);
      const body = (await res.json()) as { trips?: StoredTrip[] };
      setLoad({ phase: "ready", trips: Array.isArray(body.trips) ? body.trips : [] });
    } catch {
      setLoad({ phase: "error", message: "We could not load your trips. Please try again." });
    }
  }, []);

  useEffect(() => {
    if (resolved === undefined) return; // still resolving the session
    if (!owner) {
      // Anonymous: never fetch another traveler's data (Req 27.1).
      setLoad({ phase: "ready", trips: [] });
      return;
    }
    void loadTrips(owner);
  }, [resolved, owner, loadTrips]);

  const trips = load.phase === "ready" ? load.trips : [];
  const { bookings, itineraries } = useMemo(() => {
    const bookings: StoredTrip[] = [];
    const itineraries: StoredTrip[] = [];
    for (const trip of trips) {
      (isConfirmedBooking(trip) ? bookings : itineraries).push(trip);
    }
    return { bookings, itineraries };
  }, [trips]);

  // ── Owner-scoped Trip_Store actions (Req 27.4–27.7) ──────────────────────

  /** View: toggle an inline, fully-legible detail panel (Req 27.4). */
  const view = useCallback((tripId: string) => {
    setOpenId((current) => (current === tripId ? null : tripId));
  }, []);

  /**
   * Edit: rename the trip via the same idempotent save the Planner uses. The
   * save is keyed on the trip's own `clientDraftId`, so it updates in place for
   * this owner rather than creating a duplicate (Property 31). Scoped to the
   * resolved owner only (Req 27.5).
   */
  const edit = useCallback(
    async (trip: StoredTrip) => {
      if (!owner) return;
      const next = typeof window !== "undefined"
        ? window.prompt("Rename this trip", trip.name)
        : null;
      const name = next?.trim();
      if (!name || name === trip.name) return;
      setBusyId(trip.tripId);
      try {
        const res = await fetch("/api/trips", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            owner,
            clientDraftId: trip.clientDraftId,
            name,
            status: trip.status,
            payload: trip.payload,
            ttl: trip.ttl,
          }),
        });
        if (!res.ok) throw new Error(`Save failed (${res.status}).`);
        await loadTrips(owner);
      } catch {
        setLoad({ phase: "error", message: "We could not update that trip. Please try again." });
      } finally {
        setBusyId(null);
      }
    },
    [owner, loadTrips],
  );

  /**
   * Delete: remove the owner's own trip via the owner-scoped trips API. We send
   * the owner + tripId so the store can only ever touch this traveler's data
   * (Req 27.6). After a successful delete we reload the newest five.
   */
  const remove = useCallback(
    async (trip: StoredTrip) => {
      if (!owner) return;
      if (typeof window !== "undefined" && !window.confirm(`Delete "${trip.name}"?`)) {
        return;
      }
      setBusyId(trip.tripId);
      try {
        const res = await fetch("/api/trips", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ owner, tripId: trip.tripId }),
        });
        if (!res.ok) throw new Error(`Delete failed (${res.status}).`);
        await loadTrips(owner);
      } catch {
        setLoad({ phase: "error", message: "We could not delete that trip. Please try again." });
      } finally {
        setBusyId(null);
      }
    },
    [owner, loadTrips],
  );

  // Resume target: /plan with the trip's Trip_Context restored (Req 27.7). We
  // pass the trip id so the Planner can rehydrate the owner-scoped context.
  const resumeHref = (trip: StoredTrip) =>
    `/plan?trip=${encodeURIComponent(trip.tripId)}`;

  // ── Render ───────────────────────────────────────────────────────────────

  // Still resolving the session on first client paint — show a neutral
  // placeholder rather than briefly flashing the anonymous prompt.
  if (resolved === undefined) {
    return (
      <main className="shell my-trips">
        <p className="eyebrow">Your trips</p>
        <h1 className="display">My Trips</h1>
        <p className="lead" aria-live="polite">Loading your trips…</p>
      </main>
    );
  }

  // Anonymous: present the sign-in prompt (Req 1 entry) and no other traveler's
  // trips (Req 27.1). `AuthLanding` is the same Identity_Provider entry used on
  // the account landing page.
  if (!owner) {
    return (
      <main className="shell my-trips">
        <p className="eyebrow">Your trips</p>
        <h1 className="display">My Trips</h1>
        <p className="lead">
          Sign in to see your saved trips and confirmed bookings. We keep each
          traveler&rsquo;s trips private to their account.
        </p>
        {/* Reuses the Requirement 1 Identity_Provider landing controls. */}
        <AuthLanding policy={providerPolicy} session={null} />
      </main>
    );
  }

  const firstName = resolved?.firstName?.trim();

  return (
    <main className="shell my-trips">
      <header className="my-trips__header">
        <div>
          <p className="eyebrow">Your trips</p>
          <h1 className="display">
            {firstName ? `${firstName}'s trips` : "My Trips"}
          </h1>
        </div>
        {/* Restrained single header accent from the Illustration_Library (Req 13.1). */}
        <Image
          className="my-trips__header-art"
          src={HEADER_ILLUSTRATION.src}
          width={HEADER_ILLUSTRATION.width}
          height={HEADER_ILLUSTRATION.height}
          alt=""
          aria-hidden="true"
          priority={false}
        />
      </header>

      {load.phase === "loading" && (
        <p className="lead" aria-live="polite">Loading your trips…</p>
      )}

      {load.phase === "error" && (
        <section className="card my-trips__error" role="alert">
          <p>{load.message}</p>
          <button
            type="button"
            className="cta"
            onClick={() => owner && void loadTrips(owner)}
          >
            Try again
          </button>
        </section>
      )}

      {load.phase === "ready" && trips.length === 0 && (
        // Signed-in with no trips: invite a search or the Planner (Req 27.3).
        <section className="card motion-rise my-trips__empty" aria-labelledby="empty-heading">
          <h2 id="empty-heading" className="my-trips__empty-title">No trips yet</h2>
          <p>Start exploring stays or let the AI Travel Assistant plan something for you.</p>
          <div className="my-trips__empty-actions">
            {/* Primary_Action (orange) — discovery route (Req 13.4). */}
            <Link href="/stays" className="cta">Start a search</Link>
            {/* Secondary neutral action — planning route (Req 13.4). */}
            <Link href="/plan" className="btn">Open the Planner</Link>
          </div>
        </section>
      )}

      {load.phase === "ready" && trips.length > 0 && (
        <>
          {/* Self-created itineraries — distinct from confirmed bookings (Req 27.8). */}
          <section className="my-trips__group" aria-labelledby="itineraries-heading">
            <h2 id="itineraries-heading" className="my-trips__group-title">
              Trips you&rsquo;re planning
            </h2>
            {itineraries.length === 0 ? (
              <p className="my-trips__group-empty">
                No in-progress trips. Confirmed bookings appear below.
              </p>
            ) : (
              <ul className="my-trips__list">
                {itineraries.map((trip) => (
                  <li key={trip.tripId}>
                    <TripCard
                      trip={trip}
                      kind="itinerary"
                      open={openId === trip.tripId}
                      busy={busyId === trip.tripId}
                      onView={() => view(trip.tripId)}
                      onEdit={() => void edit(trip)}
                      onDelete={() => void remove(trip)}
                      resumeHref={isResumable(trip) ? resumeHref(trip) : null}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Confirmed bookings — presented separately, visibly distinct (Req 27.8). */}
          <section className="my-trips__group my-trips__group--bookings" aria-labelledby="bookings-heading">
            <h2 id="bookings-heading" className="my-trips__group-title">
              Confirmed bookings
            </h2>
            {bookings.length === 0 ? (
              <p className="my-trips__group-empty">No confirmed bookings yet.</p>
            ) : (
              <ul className="my-trips__list">
                {bookings.map((trip) => (
                  <li key={trip.tripId}>
                    <TripCard
                      trip={trip}
                      kind="booking"
                      open={openId === trip.tripId}
                      busy={busyId === trip.tripId}
                      onView={() => view(trip.tripId)}
                      onEdit={() => void edit(trip)}
                      onDelete={() => void remove(trip)}
                      resumeHref={null}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

/** A single trip / booking card — a clean white surface, fully legible. */
function TripCard({
  trip,
  kind,
  open,
  busy,
  onView,
  onEdit,
  onDelete,
  resumeHref,
}: {
  trip: StoredTrip;
  kind: "itinerary" | "booking";
  open: boolean;
  busy: boolean;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
  resumeHref: string | null;
}) {
  const detailId = `trip-detail-${trip.tripId}`;
  const updated = formatDate(trip.updatedAt);
  // Booking details "when available" (Req 7.8): a concise line, only shown when
  // the stored payload actually carries confirmation data (never fabricated).
  const booking = bookingDetails(trip);

  // Each card surfaces exactly one orange Primary_Action (Req 13.2): "Resume in
  // Planner" when the itinerary is resumable, otherwise the "View" control.
  const viewIsPrimary = !resumeHref;

  return (
    <article
      className={`card motion-rise my-trips__card my-trips__card--${kind}`}
    >
      <div className="my-trips__card-head">
        <div>
          <h3 className="my-trips__card-title">{trip.name}</h3>
          <p className="my-trips__card-meta">
            <span className={`my-trips__badge my-trips__badge--${kind}`}>
              {kind === "booking" ? "Confirmed booking" : "Itinerary"}
            </span>
            {updated && <span className="my-trips__updated">Updated {updated}</span>}
          </p>
          {booking && (
            // Concise booking-details line, rendered through existing classes
            // (Req 7.8). Shown only when the payload carries confirmation data.
            <p className="my-trips__card-meta">
              <span className="my-trips__updated">{booking}</span>
            </p>
          )}
        </div>
      </div>

      <div className="my-trips__actions">
        <button
          type="button"
          className={
            viewIsPrimary
              ? "my-trips__action my-trips__action--primary"
              : "my-trips__action"
          }
          onClick={onView}
          aria-expanded={open}
          aria-controls={detailId}
          disabled={busy}
        >
          {open ? "Hide details" : "View"}
        </button>
        {resumeHref && (
          <Link href={resumeHref} className="my-trips__action my-trips__action--resume">
            Resume in Planner
          </Link>
        )}
        <button
          type="button"
          className="my-trips__action"
          onClick={onEdit}
          disabled={busy}
        >
          Edit
        </button>
        <button
          type="button"
          className="my-trips__action my-trips__action--danger"
          onClick={onDelete}
          disabled={busy}
        >
          {busy ? "Working…" : "Delete"}
        </button>
      </div>

      {open && (
        <div id={detailId} className="my-trips__detail">
          <dl className="my-trips__detail-list">
            <div className="row">
              <dt>Status</dt>
              <dd>{trip.status}</dd>
            </div>
            <div className="row">
              <dt>Created</dt>
              <dd>{formatDate(trip.createdAt) ?? "—"}</dd>
            </div>
            <div className="row">
              <dt>Last updated</dt>
              <dd>{updated ?? "—"}</dd>
            </div>
          </dl>
          <TripPayload payload={trip.payload} />
        </div>
      )}
    </article>
  );
}

/** Render the stored payload summary (sensitive fields are already stripped). */
function TripPayload({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) {
    return <p className="my-trips__payload-empty">No saved details for this trip yet.</p>;
  }
  return (
    <dl className="my-trips__detail-list">
      {entries.map(([key, value]) => (
        <div className="row" key={key}>
          <dt>{key}</dt>
          <dd>{renderValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

/** Format an ISO timestamp for display; returns null for an unparseable value. */
function formatDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
