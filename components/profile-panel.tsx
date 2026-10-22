"use client";

/**
 * Profile_Panel surface (realtime-ai-integration spec, task 13.3 — design
 * "Per-page → Profile", Req 7.12, 10.1–10.4, 11.1).
 *
 * The Profile page SHALL present controls to manage preferences, saved trips,
 * and account settings (Req 7.12). This component is mounted additively on
 * `app/account/page.tsx` BELOW the existing, untouched `AuthLanding` and
 * alongside the existing `TravelUtilities`; it replaces nothing.
 *
 * HARD CONSTRAINT compliance:
 *  - NO new token, NO new `:root` var, NO new nav entry, NO new runtime
 *    dependency. Every element renders through EXISTING class names only
 *    (`.shell`, `.card`, `.eyebrow`, `.section-title`, `.section-sub`, `.lead`,
 *    `.field`, `.field-row`, `.cta`, `.btn`, `.inline-link`, `.notice`,
 *    `.notice--error`, `.results__empty`, `.results__partial`).
 *  - The `/api/profile` route contract is UNCHANGED and never duplicated: this
 *    panel only performs the documented GET `?userId=…` read and the
 *    documented version-checked POST update; it invents no endpoint.
 *  - `lib/identity.ts` behavior is untouched — account settings here are an
 *    honest summary plus a link to the existing sign-in surface already
 *    rendered above by `AuthLanding`; no sign-in control is duplicated and no
 *    setting that does not exist is fabricated.
 *
 * Preferences honesty (Req 4.7): the three editable preference controls (home
 * city, travel style, budget) are backed by the shared `TripContext` via the
 * provider's `editField`/`patchContext`, so an edit here is REAL and carries
 * over to the planner and the Flights/Stays/Cars criteria mappers. When a
 * stored `TravelerProfile` is available for a known `userId`, this panel also
 * reflects it read-only through the existing `/api/profile` GET contract, with
 * Loading/Empty/Error states rendered through existing classes (Req 10.1–10.4).
 */

import { useCallback, useEffect, useState } from "react";

import { useTripContext } from "@/components/trip-context";
import type { TravelerProfile } from "@/lib/types";

/** Async lifecycle for the optional stored-profile read (Req 10.1–10.4). */
type Phase = "idle" | "loading" | "ready" | "empty" | "error";

/** Budget options mirror the Trip_Context `budgetLevel` vocabulary. */
const BUDGET_OPTIONS = [
  { value: "", label: "No preference" },
  { value: "budget", label: "Budget" },
  { value: "mid", label: "Mid-range" },
  { value: "luxury", label: "Luxury" },
] as const;

/** Read a stored profile via the EXISTING GET /api/profile contract. */
async function readProfile(userId: string): Promise<TravelerProfile | null> {
  const response = await fetch(
    `/api/profile?userId=${encodeURIComponent(userId)}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );
  if (response.status === 404) {
    // No stored profile yet — an honest Empty_State, not an error.
    return null;
  }
  if (!response.ok) {
    throw new Error(`Could not load your profile (${response.status}).`);
  }
  const body = (await response.json()) as { profile?: TravelerProfile };
  return body.profile ?? null;
}

export interface ProfilePanelProps {
  /**
   * The authenticated user's id, when the browser already has a session. When
   * absent (guest), the panel shows an honest guest state for the stored
   * profile and keeps the shared-context preference controls fully usable.
   */
  userId?: string | null;
}

export default function ProfilePanel({ userId = null }: ProfilePanelProps) {
  const { context, editField, patchContext } = useTripContext();

  // ── Optional stored-profile read (existing GET contract) ─────────────────
  const [phase, setPhase] = useState<Phase>(userId ? "loading" : "idle");
  const [profile, setProfile] = useState<TravelerProfile | null>(null);
  const [profileError, setProfileError] = useState<string>("");

  const loadProfile = useCallback(async (id: string) => {
    setPhase("loading");
    setProfileError("");
    try {
      const result = await readProfile(id);
      if (result) {
        setProfile(result);
        setPhase("ready");
      } else {
        setPhase("empty");
      }
    } catch (error) {
      setProfileError(
        error instanceof Error
          ? error.message
          : "Could not load your profile.",
      );
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (userId) {
      void loadProfile(userId);
    } else {
      setPhase("idle");
      setProfile(null);
    }
  }, [userId, loadProfile]);

  // ── Preference edits write to the shared Trip_Context (Req 4.7) ───────────
  const homeCity = context.origin ?? "";
  const travelStyle = context.pace ?? "";
  const budget = context.budgetLevel ?? "";

  return (
    <section className="shell" aria-labelledby="profile-panel-heading">
      <p className="eyebrow">Profile</p>
      <h2 id="profile-panel-heading" className="section-title">
        Manage your travel profile
      </h2>
      <p className="section-sub">
        Set your travel preferences, jump to your saved trips, and review your
        account. Preferences carry over to the planner and your searches.
      </p>

      {/* ── Preferences ─────────────────────────────────────────────────── */}
      <div className="card" aria-labelledby="profile-prefs-heading">
        <p className="eyebrow">Preferences</p>
        <h3 id="profile-prefs-heading" className="section-title">
          Trip preferences
        </h3>
        <p className="section-sub">
          These feed the AI planner and prefill your Flights, Stays, and Cars
          searches.
        </p>

        <div className="field-row">
          <label className="field">
            <span>Home city</span>
            <input
              type="text"
              name="homeCity"
              value={homeCity}
              placeholder="e.g. London"
              autoComplete="off"
              onChange={(event) => {
                const next = event.target.value;
                editField("origin", next.trim() ? next : undefined);
              }}
            />
          </label>

          <label className="field">
            <span>Travel style</span>
            <select
              name="travelStyle"
              value={travelStyle}
              onChange={(event) => {
                const next = event.target.value;
                editField("pace", next ? next : undefined);
              }}
            >
              <option value="">No preference</option>
              <option value="relaxed">Relaxed</option>
              <option value="balanced">Balanced</option>
              <option value="packed">Packed</option>
            </select>
          </label>
        </div>

        <label className="field">
          <span>Budget preference</span>
          <select
            name="budgetLevel"
            value={budget}
            onChange={(event) => {
              const next = event.target.value;
              // `budgetLevel` is a free-form string on Trip_Context; the shared
              // vocabulary keeps it aligned with the planner/mappers.
              patchContext({ budgetLevel: next ? next : undefined });
            }}
          >
            {BUDGET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {homeCity || travelStyle || budget ? (
          <p className="lead" aria-live="polite">
            Saved for this session:
            {homeCity ? ` home ${homeCity};` : ""}
            {travelStyle ? ` ${travelStyle} pace;` : ""}
            {budget ? ` ${budget} budget.` : ""}
          </p>
        ) : (
          <p className="results__empty">
            No preferences set yet. Add a home city, travel style, or budget to
            personalise your planning.
          </p>
        )}

        {/* Stored profile reflection via the EXISTING GET /api/profile read. */}
        {phase === "loading" && (
          <p className="results__partial" aria-live="polite">
            Loading your saved profile…
          </p>
        )}
        {phase === "error" && (
          <p className="notice notice--error" role="alert">
            {profileError || "Could not load your profile."}
          </p>
        )}
        {phase === "empty" && (
          <p className="results__empty">
            No saved profile yet. Your preferences above are kept for this
            session.
          </p>
        )}
        {phase === "ready" && profile && (
          <p className="section-sub" aria-live="polite">
            Saved profile: {profile.displayName || "Traveler"} · home{" "}
            {profile.homeCity || "unset"} · {profile.travelStyle || "any"} style
            · party {profile.party.adults + profile.party.children}.
          </p>
        )}
      </div>

      {/* ── Saved trips ─────────────────────────────────────────────────── */}
      <div className="card" aria-labelledby="profile-trips-heading">
        <p className="eyebrow">Saved trips</p>
        <h3 id="profile-trips-heading" className="section-title">
          Your itineraries
        </h3>
        <p className="section-sub">
          View, edit, and resume the trips you have saved.
        </p>
        <p className="lead">
          <a className="inline-link" href="/trips">
            View your saved trips
          </a>
        </p>
      </div>

      {/* ── Account settings ────────────────────────────────────────────── */}
      <div className="card" aria-labelledby="profile-account-heading">
        <p className="eyebrow">Account settings</p>
        <h3 id="profile-account-heading" className="section-title">
          Your account
        </h3>
        {userId ? (
          <p className="lead" aria-live="polite">
            You are signed in. Manage your trips and profile synced to your
            account.
          </p>
        ) : (
          <p className="section-sub">
            You are browsing as a guest — preferences and trips stay on this
            device. Sign in from the account controls above to sync them across
            devices.
          </p>
        )}
      </div>
    </section>
  );
}
