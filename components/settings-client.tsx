"use client";

/**
 * Settings / preferences surface (select-only).
 * Every basic-info and travel field is a dropdown or a choice chip - no free
 * text. Loads from and saves to browser-local storage via lib/preferences.
 */

import { useEffect, useRef, useState } from "react";
import {
  COUNTRIES,
  HOME_CITIES,
  TRAVEL_STYLES,
  PACES,
  DIETS,
  TRIP_LENGTHS,
  INTERESTS,
  TRAVELLER_COUNTS,
  DEFAULT_PREFERENCES,
  loadPreferences,
  savePreferences,
  type Option,
  type TravelPreferences,
} from "@/lib/preferences";
import { fetchSession, subscribeSession } from "@/lib/client/account-session";
import { pullPreferences, saveAndSyncPreferences } from "@/lib/client/preferences-sync";
import { useSyncStatus } from "@/lib/client/use-sync-status";

function SelectField({ id, label, value, options, onChange }: {
  id: string; label: string; value: string; options: readonly Option[]; onChange: (v: string) => void;
}) {
  return (
    <label className="field settings__field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

export default function SettingsClient() {
  const [prefs, setPrefs] = useState<TravelPreferences>(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);

  const [signedIn, setSignedIn] = useState(false);
  const dirty = useRef(false);
  const signedInRef = useRef(false);
  const sync = useSyncStatus();

  useEffect(() => {
    let cancelled = false;
    setPrefs(loadPreferences());
    setLoaded(true);

    // Signed-in: server values replace local ones (or local are uploaded once).
    async function startSync() {
      const pulled = await pullPreferences();
      if (cancelled) return;
      // Do not overwrite edits the user started while the request was in flight.
      if (pulled.kind === "applied" && !dirty.current) setPrefs(pulled.preferences);
    }
    void fetchSession().then((s) => {
      if (cancelled || s.error) return;
      const was = signedInRef.current; // fetchSession also notifies subscribers
      signedInRef.current = s.signedIn;
      setSignedIn(s.signedIn);
      if (s.signedIn && !was) void startSync();
    });
    const unsubscribe = subscribeSession((s) => {
      if (cancelled) return;
      const was = signedInRef.current;
      signedInRef.current = s.signedIn;
      setSignedIn(s.signedIn);
      if (s.signedIn && !was) void startSync();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  function set<K extends keyof TravelPreferences>(key: K, value: TravelPreferences[K]) {
    dirty.current = true;
    setPrefs((p) => ({ ...p, [key]: value }));
    setSaved(false);
  }

  function toggleInterest(v: string) {
    dirty.current = true;
    setPrefs((p) => {
      const has = p.interests.includes(v);
      const interests = has ? p.interests.filter((x) => x !== v) : [...p.interests, v];
      return { ...p, interests };
    });
    setSaved(false);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Local first, so the values survive a failed sync.
    const ok = savePreferences(prefs);
    setSaved(ok);
    dirty.current = false;
    if (signedIn) void saveAndSyncPreferences(prefs);
  }

  return (
    <main className="shell settings">
      <section className="results__summary motion-rise" aria-label="Settings">
        <p className="eyebrow">Settings</p>
        <h1>Your travel preferences</h1>
        <p className="settings__lead">Pick from the options below - no typing needed. We use these to tailor your plans. Saved on this device.</p>
      </section>

      <form className="card settings__form" onSubmit={onSubmit}>
        <fieldset className="settings__group">
          <legend className="settings__legend">Basic info</legend>
          <div className="settings__grid">
            <SelectField id="country" label="Country" value={prefs.country} options={COUNTRIES} onChange={(v) => set("country", v)} />
            <SelectField id="homeCity" label="Home city" value={prefs.homeCity} options={HOME_CITIES} onChange={(v) => set("homeCity", v)} />
            <SelectField id="travellers" label="Travellers" value={String(prefs.travellers)} options={TRAVELLER_COUNTS.map((n) => ({ value: String(n), label: n === 1 ? "1 traveller" : n + " travellers" }))} onChange={(v) => set("travellers", Number(v))} />
          </div>
        </fieldset>

        <fieldset className="settings__group">
          <legend className="settings__legend">How you travel</legend>
          <div className="settings__grid">
            <SelectField id="travelStyle" label="Travel style" value={prefs.travelStyle} options={TRAVEL_STYLES} onChange={(v) => set("travelStyle", v)} />
            <SelectField id="pace" label="Pace" value={prefs.pace} options={PACES} onChange={(v) => set("pace", v)} />
            <SelectField id="tripLength" label="Typical trip length" value={prefs.tripLength} options={TRIP_LENGTHS} onChange={(v) => set("tripLength", v)} />
            <SelectField id="diet" label="Diet" value={prefs.diet} options={DIETS} onChange={(v) => set("diet", v)} />
          </div>
        </fieldset>

        <fieldset className="settings__group">
          <legend className="settings__legend">Interests</legend>
          <p className="settings__hint">Tap to select any that apply.</p>
          <div className="settings__chips" role="group" aria-label="Interests">
            {INTERESTS.map((o) => {
              const active = prefs.interests.includes(o.value);
              return (
                <button
                  type="button"
                  key={o.value}
                  className={"settings__chip" + (active ? " settings__chip--on" : "")}
                  aria-pressed={active}
                  onClick={() => toggleInterest(o.value)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="settings__actions">
          <button type="submit" className="cta" disabled={!loaded}>Save preferences</button>
          {saved && <span className="settings__saved" role="status">{signedIn && sync.state === "saved" ? "Saved and synced to your account." : "Saved on this device."}</span>}
          {signedIn && sync.state === "saving" && <span className="settings__saved" role="status">Syncing...</span>}
          {signedIn && sync.state === "failed" && (
            <span className="settings__saved" role="alert">
              {sync.note ?? "Could not sync."}{" "}
              {sync.retry && <button type="button" className="btn" onClick={sync.retry}>Retry sync</button>}
            </span>
          )}
        </div>
      </form>
    </main>
  );
}
