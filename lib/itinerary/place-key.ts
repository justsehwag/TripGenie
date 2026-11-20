/**
 * Place keys and title rules for the trustworthy itinerary.
 * Pure and total: imports only lib/grounding/place-match.ts and lib/cost-classifier.ts
 * (both client-safe); never throws.
 */
import { normalizePlaceText } from "@/lib/grounding/place-match";
import { classifyActivity } from "@/lib/cost-classifier";

export type StopKind = "sight" | "meal" | "experience";

/**
 * Name key: case, whitespace, punctuation and diacritics folded.
 * normalizePlaceText already does NFD + mark strip + lower-case + punctuation to
 * space + collapse. Extra folding here covers letters NFD cannot decompose and
 * compatibility forms, so equal-looking names share one key.
 */
export function nameKey(name: string): string {
  try {
    const base = normalizePlaceText(typeof name === "string" ? name : String(name ?? ""));
    return base
      .normalize("NFKC")
      .replace(/ß/g, "ss")
      .replace(/æ/g, "ae")
      .replace(/œ/g, "oe")
      .replace(/ø/g, "o")
      .replace(/đ/g, "d")
      .replace(/ł/g, "l")
      .replace(/ı/g, "i")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

const TIME_WORDS = "(?:early |late |leisurely |relaxed |lazy |free )?(?:morning|afternoon|evening|night|midday|noon|sunset|sunrise|dawn|dusk)";
const TIME_NOUNS =
  "(?:activity|activities|experience|experiences|walk|stroll|tour|meal|lunch|dinner|breakfast|brunch|snack|snacks|drinks|relaxation|exploration|sightseeing|visit|adventure|outing|session|break|leisure|rest|time|fun|plan|plans|programme|program|excursion|trip)";

/** Time-of-day word plus generic noun(s) only, e.g. "morning walk". "Sunset Point" does not match. */
const TIME_GENERIC_RE = new RegExp(`^(?:an? |the |some )?${TIME_WORDS}(?: ${TIME_NOUNS})+$`);

const LOCAL_ADJ = "(?:local|signature|traditional|authentic|typical|regional|famous|popular|nearby|special|unique|cultural|scenic|hidden|best)";
const LOCAL_NOUN =
  "(?:lunch|dinner|breakfast|brunch|food|foods|cuisine|meal|meals|restaurant|restaurants|cafe|cafes|eatery|eateries|experience|experiences|activity|activities|market|markets|dish|dishes|snack|snacks|sightseeing|attraction|attractions|spot|spots|place|places|culture|sights|sight|tour|walk|show|performance|shopping|stay|hotel)";
const ADJ_NOUN_RE = new RegExp(`^(?:an? |the |some )?${LOCAL_ADJ}(?: ${LOCAL_ADJ})*(?: \\w+)? ${LOCAL_NOUN}$`);

const EXPLORE_RE =
  /^(?:explore|discover|wander|wander around|walk around|stroll around|walk|stroll|visit|see|enjoy|relax in|tour|sightsee in|sightseeing in|exploring|discovering|sightseeing around|around)(?: (?:the|a|some|around|in|around the))*(?: (?:city|town|area|old town|old city|local area|destination|neighbourhood|neighborhood|surroundings|streets|downtown|city centre|city center|local markets?|local culture|local life|nearby|nearby area|nearby sights|village|island|region))+$/;

const EXACT_GENERIC = new Set<string>([
  "free time", "free day", "free morning", "free afternoon", "free evening", "leisure", "leisure time",
  "at leisure", "day at leisure", "relax", "relaxation", "rest", "rest day", "downtime",
  "sightseeing", "city sightseeing", "local sightseeing", "city tour", "local tour", "walking tour",
  "shopping", "local shopping", "souvenir shopping",
  "lunch", "dinner", "breakfast", "brunch", "snack", "snacks", "meal", "food", "street food", "local food",
  "activity", "activities", "experience", "optional activity", "optional experience", "own arrangements",
  "on your own", "explore on your own", "explore", "discover", "sunset", "sunrise",
  "signature experience", "local experience", "cultural experience", "evening experience", "afternoon activity",
  "morning activity", "explore the city", "explore the area", "local lunch", "local dinner", "local breakfast",
  "to be decided", "tbd", "tba", "n a", "na", "none", "unknown", "something fun",
]);

/** True when the title names no specific place. Total; an empty title is generic. */
export function isGenericTitle(title: string): boolean {
  try {
    const k = nameKey(typeof title === "string" ? title : "");
    if (!k) return true;
    if (EXACT_GENERIC.has(k)) return true;
    if (TIME_GENERIC_RE.test(k)) return true;
    if (ADJ_NOUN_RE.test(k)) return true;
    if (EXPLORE_RE.test(k)) return true;
    return false;
  } catch {
    return true;
  }
}

const VENUE_NOUN_RE =
  /\b(restaurants?|cafes?|caf\u00e9s?|warungs?|markets?|food streets?|food courts?|bakery|bakeries|kitchen|bistro|eatery|diner|dhaba|canteen|trattoria|pizzeria|brasserie|taverna|izakaya|ramen|sushi|bar|grill|pub|tavern|tea house|teahouse|roastery|patisserie|deli|cantina|osteria)\b/iu;

/** Words that describe a cuisine, a meal or a generic modifier: they never identify a venue. */
const NON_VENUE_WORDS = new Set<string>(
  (
    "local traditional authentic regional famous popular best nearby typical special street food foods cuisine " +
    "indian balinese indonesian italian thai chinese japanese korean french mexican seafood vegetarian vegan asian " +
    "western european continental mediterranean greek turkish vietnamese nepali tibetan punjabi gujarati rajasthani " +
    "south north east west breakfast lunch dinner brunch snack snacks meal meals dishes dish specialty specialties " +
    "hotel at in near around the a an of for and with to by on from"
  ).split(" "),
);

/**
 * A meal Stop must name a venue, not a district or a cuisine.
 * True when the name has a venue noun, or a capitalised word that is neither a
 * cuisine nor a generic word. Generic titles are never venue-specific.
 */
export function isVenueSpecificMeal(name: string): boolean {
  try {
    const raw = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
    if (!raw || isGenericTitle(raw)) return false;
    const words = raw.split(/[\s,;:()/&-]+/).filter(Boolean);
    const proper = words.some((w) => /^\p{Lu}/u.test(w) && !NON_VENUE_WORDS.has(nameKey(w)));
    if (proper) return true;
    if (VENUE_NOUN_RE.test(raw)) {
      // A venue noun counts only with at least one other word that is not generic.
      return words.some((w) => !NON_VENUE_WORDS.has(nameKey(w)) && !VENUE_NOUN_RE.test(w));
    }
    return false;
  } catch {
    return false;
  }
}

/** True for stay check-in and route-transport titles: they are not places to visit. */
export function isNonStopTitle(
  title: string,
  ctx?: { origin?: string; destination?: string },
): boolean {
  try {
    const c = classifyActivity({ title: typeof title === "string" ? title : "" }, ctx ?? {});
    return c === "stay-checkin" || c === "route-transport";
  } catch {
    return false;
  }
}

/** True when all day titles are pairwise different after nameKey. Empty titles count as equal to each other. */
export function distinctDayTitles(titles: readonly string[]): boolean {
  try {
    const seen = new Set<string>();
    for (const t of Array.isArray(titles) ? titles : []) {
      const k = nameKey(typeof t === "string" ? t : "");
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return true;
  } catch {
    return false;
  }
}
