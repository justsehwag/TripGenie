"use client";

/**
 * Recent saved trips on the Account profile.
 * Spec: welcome-idle-saved-trips, Requirements 4.1, 4.3, 4.6-4.15.
 *
 * Data is real: signed-in travelers get one `GET /api/trips` (the server scopes
 * it to the session owner, same call as My Trips / use-scoped-history); guests
 * get this device's local history. Rows come from `selectRecentTrips`.
 * `/plan?trip=<id>` resumes a stored record of any status (the concierge calls
 * `useScopedHistory().resume`, which looks the id up without filtering status),
 * so every row uses the same Open link.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { handleUnauthorized } from "@/lib/client/account-session";
import { readLocalHistory } from "@/lib/history/local-store";
import { selectRecentTrips, type RecentTripRow } from "@/lib/recent-trips";
import type { StoredTrip } from "@/lib/trip-retention";

export type RecentTripsStatus = "loading" | "ready" | "error" | "unavailable";

export interface RecentTripsViewProps {
  status: RecentTripsStatus;
  trips: readonly RecentTripRow[];
  signedIn: boolean;
  onRetry?: () => void;
}

/** Pure presentational view (exported for tests). */
export function RecentTripsView({ status, trips, signedIn, onRetry }: RecentTripsViewProps) {
  const headingId = "account-recent-heading";
  return (
    <section className="account-recent" aria-labelledby={headingId}>
      <h2 id={headingId} className="account-recent__title">
        {signedIn ? "Saved trips" : "Saved on this device"}
      </h2>

      {status === "loading" && (
        <div className="skeleton" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading your saved trips…</span>
          <div className="skeleton__block skeleton__block--title" />
          <div className="skeleton__card" />
        </div>
      )}

      {(status === "error" || status === "unavailable") && (
        <div className="account-recent__error" role="alert">
          <p>
            {status === "unavailable"
              ? "Trip storage is unavailable right now. Please try again later."
              : "We could not load your saved trips. Please try again."}
          </p>
          {onRetry && (
            <button type="button" className="btn" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}

      {status === "ready" && trips.length === 0 && (
        <div className="account-recent__empty">
          <p>
            {signedIn
              ? "No saved trips yet."
              : "No trips saved on this device yet."}
          </p>
          <Link href="/plan" className="cta">
            Plan a trip
          </Link>
        </div>
      )}

      {status === "ready" && trips.length > 0 && (
        <ol className="account-recent__list">
          {trips.map((trip) => (
            <li key={trip.tripId} className="account-recent__row">
              <div className="account-recent__main">
                <span className="account-recent__name">{trip.name}</span>
                {trip.destination && (
                  <span className="account-recent__dest">{trip.destination}</span>
                )}
                <span className="account-recent__when">{trip.whenLabel}</span>
              </div>
              <Link
                href={trip.href}
                className="account-recent__open"
                aria-label={`Open ${trip.name}`}
              >
                Open
              </Link>
            </li>
          ))}
        </ol>
      )}

      {status === "ready" &&
        (signedIn ? (
          <p className="account-recent__more">
            <Link href="/trips">See all in My Trips</Link>
          </p>
        ) : (
          <p className="account-recent__note">
            Sign in to keep your trips on your account.
          </p>
        ))}
    </section>
  );
}

export interface AccountRecentTripsProps {
  signedIn: boolean;
}

/** Hook plus view: loads the real trips for the current scope. */
export function AccountRecentTrips({ signedIn }: AccountRecentTripsProps) {
  const [status, setStatus] = useState<RecentTripsStatus>("loading");
  const [trips, setTrips] = useState<RecentTripRow[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    if (!signedIn) {
      setTrips(selectRecentTrips(readLocalHistory()));
      setStatus("ready");
      return () => {
        cancelled = true;
      };
    }

    setStatus("loading");
    void (async () => {
      try {
        const res = await fetch("/api/trips", {
          method: "GET",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.status === 401) {
          handleUnauthorized();
          setStatus("error");
          return;
        }
        if (res.status === 503) {
          setStatus("unavailable");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const body = (await res.json()) as { trips?: StoredTrip[] };
        if (cancelled) return;
        setTrips(selectRecentTrips(Array.isArray(body.trips) ? body.trips : []));
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signedIn, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return <RecentTripsView status={status} trips={trips} signedIn={signedIn} onRetry={retry} />;
}

export default AccountRecentTrips;
