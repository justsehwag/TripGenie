/**
 * Traveller preferences (select-only).
 *
 * Basic info + travel fields captured entirely through dropdowns / choice
 * chips - no free-text entry. Persisted browser-local (tripgenie.preferences.v1),
 * like the guest session/history, so it works without sign-in and never blocks
 * on the network. Pure + SSR-safe: every read/write is guarded.
 */

export const PREFERENCES_KEY = "tripgenie.preferences.v1";

export interface Option { value: string; label: string; }

/** A compact, representative country list (ISO names); select-only. */
export const COUNTRIES: readonly Option[] = [
  { value: "IN", label: "India" },
  { value: "US", label: "United States" },
  { value: "GB", label: "United Kingdom" },
  { value: "AE", label: "United Arab Emirates" },
  { value: "SG", label: "Singapore" },
  { value: "AU", label: "Australia" },
  { value: "CA", label: "Canada" },
  { value: "FR", label: "France" },
  { value: "DE", label: "Germany" },
  { value: "IT", label: "Italy" },
  { value: "ES", label: "Spain" },
  { value: "JP", label: "Japan" },
  { value: "TH", label: "Thailand" },
  { value: "ID", label: "Indonesia" },
  { value: "CH", label: "Switzerland" },
  { value: "AE", label: "UAE" },
];

export const HOME_CITIES: readonly Option[] = [
  { value: "Mumbai", label: "Mumbai" },
  { value: "Delhi", label: "Delhi" },
  { value: "Bengaluru", label: "Bengaluru" },
  { value: "Chennai", label: "Chennai" },
  { value: "Hyderabad", label: "Hyderabad" },
  { value: "London", label: "London" },
  { value: "New York", label: "New York" },
  { value: "Dubai", label: "Dubai" },
  { value: "Singapore", label: "Singapore" },
  { value: "Other", label: "Other" },
];

export const TRAVEL_STYLES: readonly Option[] = [
  { value: "balanced", label: "Balanced" },
  { value: "budget", label: "Budget" },
  { value: "comfort", label: "Comfort" },
  { value: "luxury", label: "Luxury" },
];

export const PACES: readonly Option[] = [
  { value: "relaxed", label: "Relaxed" },
  { value: "moderate", label: "Moderate" },
  { value: "packed", label: "Packed" },
];

export const DIETS: readonly Option[] = [
  { value: "no_preference", label: "No preference" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "halal", label: "Halal" },
  { value: "jain", label: "Jain" },
  { value: "gluten_free", label: "Gluten-free" },
];

export const TRIP_LENGTHS: readonly Option[] = [
  { value: "weekend", label: "Weekend (2-3 days)" },
  { value: "short", label: "Short (4-5 days)" },
  { value: "week", label: "A week (6-8 days)" },
  { value: "long", label: "Long (9+ days)" },
];

export const INTERESTS: readonly Option[] = [
  { value: "culture", label: "Culture & history" },
  { value: "food", label: "Food & dining" },
  { value: "nature", label: "Nature & outdoors" },
  { value: "beaches", label: "Beaches" },
  { value: "nightlife", label: "Nightlife" },
  { value: "shopping", label: "Shopping" },
  { value: "adventure", label: "Adventure" },
  { value: "relaxation", label: "Relaxation & spa" },
  { value: "family", label: "Family-friendly" },
];

export interface TravelPreferences {
  country: string;
  homeCity: string;
  travelStyle: string;
  pace: string;
  diet: string;
  tripLength: string;
  travellers: number;
  interests: string[];
}

export const TRAVELLER_COUNTS: readonly number[] = [1, 2, 3, 4, 5, 6];

export const DEFAULT_PREFERENCES: TravelPreferences = {
  country: "IN",
  homeCity: "Mumbai",
  travelStyle: "balanced",
  pace: "moderate",
  diet: "no_preference",
  tripLength: "short",
  travellers: 2,
  interests: ["culture", "food"],
};

function inOptions(value: unknown, options: readonly Option[], fallback: string): string {
  return typeof value === "string" && options.some((o) => o.value === value) ? value : fallback;
}

/** Coerce any stored/partial object into a valid TravelPreferences (total). */
export function normalizePreferences(raw: unknown): TravelPreferences {
  const o = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const interestsRaw = Array.isArray(o.interests) ? o.interests : [];
  const interests = INTERESTS.map((i) => i.value).filter((v) => interestsRaw.includes(v));
  const t = Number(o.travellers);
  return {
    country: inOptions(o.country, COUNTRIES, DEFAULT_PREFERENCES.country),
    homeCity: inOptions(o.homeCity, HOME_CITIES, DEFAULT_PREFERENCES.homeCity),
    travelStyle: inOptions(o.travelStyle, TRAVEL_STYLES, DEFAULT_PREFERENCES.travelStyle),
    pace: inOptions(o.pace, PACES, DEFAULT_PREFERENCES.pace),
    diet: inOptions(o.diet, DIETS, DEFAULT_PREFERENCES.diet),
    tripLength: inOptions(o.tripLength, TRIP_LENGTHS, DEFAULT_PREFERENCES.tripLength),
    travellers: TRAVELLER_COUNTS.includes(t) ? t : DEFAULT_PREFERENCES.travellers,
    interests: interests.length > 0 ? interests : DEFAULT_PREFERENCES.interests,
  };
}

/** Load preferences from browser-local storage; defaults when absent/corrupt. */
export function loadPreferences(): TravelPreferences {
  if (typeof window === "undefined") return { ...DEFAULT_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return normalizePreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Save preferences; returns true on success, false when storage is unavailable. */
export function savePreferences(prefs: TravelPreferences): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(normalizePreferences(prefs)));
    return true;
  } catch {
    return false;
  }
}
