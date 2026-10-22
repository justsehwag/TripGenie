/**
 * World places dataset (pure) - a curated set of famously beautiful destinations
 * for the Discover "tourist place search engine". Each entry is framework-free
 * data; the Discover surface shuffles the set per visit (dynamic feel) and
 * enriches each card with a live image, weather and currency at render time.
 */

export interface WorldPlace {
  /** Stable id for React keys and detail lookups. */
  id: string;
  name: string;
  country: string;
  /** ISO-4217 currency code for the live FX chip (quoted into INR). */
  currency: string;
  /** Short editorial tagline (not live data). */
  blurb: string;
  /** Rough region tag for grouping/search. */
  region: "Asia" | "Europe" | "Americas" | "Africa" | "Oceania" | "Middle East";
  /** A couple of keywords to improve the image/search query. */
  tags: string[];
}

export const WORLD_PLACES: WorldPlace[] = [
  { id: "santorini", name: "Santorini", country: "Greece", currency: "EUR", blurb: "Whitewashed cliffs above a blue caldera.", region: "Europe", tags: ["island", "sunset", "aegean"] },
  { id: "kyoto", name: "Kyoto", country: "Japan", currency: "JPY", blurb: "Temples, bamboo groves and old-town lanes.", region: "Asia", tags: ["temple", "culture", "gardens"] },
  { id: "banff", name: "Banff", country: "Canada", currency: "CAD", blurb: "Turquoise lakes under the Canadian Rockies.", region: "Americas", tags: ["mountains", "lake", "nature"] },
  { id: "venice", name: "Venice", country: "Italy", currency: "EUR", blurb: "Canals, bridges and Renaissance palazzi.", region: "Europe", tags: ["canals", "romance", "history"] },
  { id: "bali", name: "Bali", country: "Indonesia", currency: "IDR", blurb: "Rice terraces, temples and warm surf.", region: "Asia", tags: ["beach", "temple", "jungle"] },
  { id: "machu-picchu", name: "Machu Picchu", country: "Peru", currency: "PEN", blurb: "An Incan citadel high in the Andes.", region: "Americas", tags: ["ruins", "mountains", "history"] },
  { id: "cape-town", name: "Cape Town", country: "South Africa", currency: "ZAR", blurb: "Table Mountain meets two oceans.", region: "Africa", tags: ["mountain", "coast", "wine"] },
  { id: "queenstown", name: "Queenstown", country: "New Zealand", currency: "NZD", blurb: "Alpine lakes and adventure under the Remarkables.", region: "Oceania", tags: ["lake", "adventure", "mountains"] },
  { id: "petra", name: "Petra", country: "Jordan", currency: "JOD", blurb: "A rose-red city carved into canyon walls.", region: "Middle East", tags: ["ruins", "desert", "history"] },
  { id: "paris", name: "Paris", country: "France", currency: "EUR", blurb: "Boulevards, museums and corner cafes.", region: "Europe", tags: ["city", "art", "romance"] },
  { id: "dubai", name: "Dubai", country: "UAE", currency: "AED", blurb: "Desert adventure meets a futuristic skyline.", region: "Middle East", tags: ["city", "desert", "luxury"] },
  { id: "reykjavik", name: "Reykjavik", country: "Iceland", currency: "ISK", blurb: "Northern lights, geysers and black-sand coasts.", region: "Europe", tags: ["aurora", "nature", "volcanic"] },
  { id: "rio", name: "Rio de Janeiro", country: "Brazil", currency: "BRL", blurb: "Beaches, peaks and carnival energy.", region: "Americas", tags: ["beach", "mountains", "city"] },
  { id: "marrakech", name: "Marrakech", country: "Morocco", currency: "MAD", blurb: "Souks, riads and desert gateways.", region: "Africa", tags: ["market", "desert", "culture"] },
  { id: "halong", name: "Ha Long Bay", country: "Vietnam", currency: "VND", blurb: "Limestone karsts rising from emerald water.", region: "Asia", tags: ["bay", "islands", "nature"] },
  { id: "amalfi", name: "Amalfi Coast", country: "Italy", currency: "EUR", blurb: "Cliffside villages above the Tyrrhenian Sea.", region: "Europe", tags: ["coast", "villages", "scenic"] },
  { id: "swiss-alps", name: "Interlaken", country: "Switzerland", currency: "CHF", blurb: "Between two lakes beneath the Jungfrau.", region: "Europe", tags: ["alps", "lakes", "adventure"] },
  { id: "maldives", name: "Maldives", country: "Maldives", currency: "MVR", blurb: "Overwater villas on turquoise lagoons.", region: "Asia", tags: ["beach", "island", "reef"] },
  { id: "new-york", name: "New York", country: "USA", currency: "USD", blurb: "Big-city energy around every block.", region: "Americas", tags: ["city", "skyline", "culture"] },
  { id: "sydney", name: "Sydney", country: "Australia", currency: "AUD", blurb: "Harbour icons and sun-washed beaches.", region: "Oceania", tags: ["harbour", "beach", "city"] },
  { id: "istanbul", name: "Istanbul", country: "Turkey", currency: "TRY", blurb: "Where two continents and empires meet.", region: "Europe", tags: ["history", "bazaar", "mosque"] },
  { id: "serengeti", name: "Serengeti", country: "Tanzania", currency: "TZS", blurb: "Endless plains and the great migration.", region: "Africa", tags: ["safari", "wildlife", "plains"] },
  { id: "singapore", name: "Singapore", country: "Singapore", currency: "SGD", blurb: "Gardens, skylines and hawker food.", region: "Asia", tags: ["city", "gardens", "food"] },
  { id: "patagonia", name: "Patagonia", country: "Argentina", currency: "ARS", blurb: "Glaciers, granite spires and open wilderness.", region: "Americas", tags: ["glacier", "mountains", "trek"] },
];

/** Lookup by id. */
export function placeById(id: string): WorldPlace | undefined {
  return WORLD_PLACES.find((p) => p.id === id);
}

/**
 * Deterministic seeded shuffle (Fisher-Yates with a mulberry32 PRNG). The
 * Discover surface passes a per-visit seed (e.g. Date.now()) so the order is
 * fresh on each load - the "dynamic / refreshes each time" behaviour - while
 * remaining a pure function of its seed for testability.
 */
export function shuffledPlaces(seed: number): WorldPlace[] {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...WORLD_PLACES];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Case-insensitive search over name/country/region/tags. */
export function searchPlaces(query: string): WorldPlace[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return WORLD_PLACES.filter((p) =>
    [p.name, p.country, p.region, ...p.tags].some((field) => field.toLowerCase().includes(q)),
  );
}