/**
 * Sights / Discover engine (pure) - TripGenie feature parity with the TripSaathi
 * "six prominent sights, restricted to the destination" surface (FR-13 / FR-17 /
 * FR-38), re-expressed in TripGenie's own structure and voice.
 *
 * The module is intentionally pure and deterministic: given a destination it
 * returns EXACTLY six curated seed sights (or six generated placeholders for an
 * unknown city), each already carrying a labelled imagery request that targets
 * TripGenie's own /api/image route. A separate, injectable enrichment step may
 * overlay a live Wikipedia summary; failure/timeout leaves the curated seed in
 * place and is reported as mode "curated" rather than throwing (labelled
 * fallback, mirroring lib/live-data.ts).
 */

export type SightMode = "live" | "curated";

export interface Sight {
  /** Stable key for React lists and image caching. */
  id: string;
  name: string;
  area: string;
  description: string;
  /** Destination this sight is restricted to (echoed for the UI copy). */
  destination: string;
  /** Provenance of the description/image enrichment. */
  mode: SightMode;
  /** Source page when a live summary supplied one. */
  sourceUrl: string | null;
  /** A TripGenie /api/image request that always resolves to a real photo. */
  image: { kind: "attraction"; query: string; slot: number };
}

export interface SightsResult {
  destination: string;
  sights: Sight[];
  restriction: string;
  retrievedAt: string;
}

type Seed = { name: string; area: string; description: string };

/**
 * Curated six-per-destination seeds. Kept small and factual; the live step may
 * replace the description with a Wikipedia summary when one is available.
 */
const CURATED: Record<string, Seed[]> = {
  Dubai: [
    { name: "Burj Khalifa", area: "Downtown Dubai", description: "The city's landmark observation tower and skyline experience." },
    { name: "Dubai Mall", area: "Downtown Dubai", description: "Shopping, dining, an aquarium and family attractions beside Burj Khalifa." },
    { name: "Museum of the Future", area: "Trade Centre", description: "Immersive exhibits exploring future science, society and technology." },
    { name: "Palm Jumeirah", area: "Palm Jumeirah", description: "The palm-shaped island known for resorts, beaches and waterfront views." },
    { name: "Al Fahidi Historical Neighbourhood", area: "Bur Dubai", description: "Restored lanes, wind towers, galleries and Emirati cultural spaces." },
    { name: "Dubai Marina", area: "Dubai Marina", description: "A lively waterfront promenade with dining, cruises and skyline views." },
  ],
  Singapore: [
    { name: "Gardens by the Bay", area: "Marina Bay", description: "Supertrees, climate conservatories and evening garden displays." },
    { name: "Marina Bay Sands", area: "Marina Bay", description: "Skyline landmark with an observation deck and waterfront setting." },
    { name: "Singapore Botanic Gardens", area: "Tanglin", description: "UNESCO-listed tropical gardens and the National Orchid Garden." },
    { name: "Chinatown", area: "Outram", description: "Heritage streets, temples, markets and local food." },
    { name: "Sentosa", area: "Southern Islands", description: "Beaches, family attractions and resort experiences." },
    { name: "Kampong Glam", area: "Rochor", description: "Malay heritage, Sultan Mosque, boutiques and colourful lanes." },
  ],
  London: [
    { name: "Tower of London", area: "Tower Hill", description: "Historic fortress, royal palace and home of the Crown Jewels." },
    { name: "British Museum", area: "Bloomsbury", description: "World history and culture collections in a landmark museum." },
    { name: "Westminster Abbey", area: "Westminster", description: "Gothic royal church central to British ceremonial history." },
    { name: "Borough Market", area: "Southwark", description: "Historic food market with British and international flavours." },
    { name: "Tate Modern", area: "Bankside", description: "Modern art in a converted power station beside the Thames." },
    { name: "Hyde Park", area: "Central London", description: "Royal park for walking, boating and relaxed city time." },
  ],
  Switzerland: [
    { name: "Lake Lucerne", area: "Lucerne", description: "A scenic alpine lake for waterfront walks and boat journeys." },
    { name: "Jungfraujoch", area: "Bernese Alps", description: "High-altitude rail journey with glacier and mountain panoramas." },
    { name: "Old City of Bern", area: "Bern", description: "UNESCO-listed arcades, fountains and medieval streets." },
    { name: "Chillon Castle", area: "Montreux", description: "Historic lakeside castle on the eastern shore of Lake Geneva." },
    { name: "Matterhorn", area: "Zermatt", description: "Switzerland's iconic mountain and a centre for alpine experiences." },
    { name: "Rhine Falls", area: "Schaffhausen", description: "Europe's powerful waterfall with viewpoints and boat excursions." },
  ],
  Paris: [
    { name: "Eiffel Tower", area: "7th arrondissement", description: "Paris landmark with observation decks and city views." },
    { name: "Louvre Museum", area: "1st arrondissement", description: "Major art museum housed in a former royal palace." },
    { name: "Montmartre", area: "18th arrondissement", description: "Hilltop neighbourhood of artists, cafes and Sacre-Coeur." },
    { name: "Musee d'Orsay", area: "7th arrondissement", description: "Impressionist art inside a converted railway station." },
    { name: "Sainte-Chapelle", area: "Ile de la Cite", description: "Gothic chapel celebrated for its stained glass." },
    { name: "Luxembourg Gardens", area: "6th arrondissement", description: "Formal gardens ideal for a slower Paris afternoon." },
  ],
  Tokyo: [
    { name: "Senso-ji", area: "Asakusa", description: "Tokyo's oldest Buddhist temple and lively approach street." },
    { name: "Meiji Shrine", area: "Shibuya", description: "Forest shrine dedicated to Emperor Meiji and Empress Shoken." },
    { name: "Tokyo Skytree", area: "Sumida", description: "Broadcast tower with panoramic observation decks." },
    { name: "Shibuya Crossing", area: "Shibuya", description: "The city's iconic pedestrian crossing and neon district." },
    { name: "Tsukiji Outer Market", area: "Chuo", description: "Food lanes known for seafood, snacks and kitchen culture." },
    { name: "teamLab Planets", area: "Toyosu", description: "Immersive digital-art museum with large-scale installations." },
  ],
};

/** Case-insensitive lookup of a curated destination key. */
function curatedKey(city: string): string | null {
  const needle = city.trim().toLowerCase();
  return Object.keys(CURATED).find((k) => k.toLowerCase() === needle) ?? null;
}

/** Six generated placeholders for a city with no curated seeds. */
function generatedSeeds(city: string): Seed[] {
  return [
    { name: `${city} historic centre`, area: city, description: `Explore the historic heart and local architecture of ${city}.` },
    { name: `${city} city museum`, area: city, description: `Discover the history, art and identity of ${city}.` },
    { name: `${city} central market`, area: city, description: `Taste local food and browse regional crafts in ${city}.` },
    { name: `${city} signature viewpoint`, area: city, description: `Take in a memorable city or landscape view within ${city}.` },
    { name: `${city} cultural quarter`, area: city, description: `Walk through a neighbourhood shaped by ${city} culture.` },
    { name: `${city} urban park`, area: city, description: `Add a relaxed green-space break without leaving ${city}.` },
  ];
}

/** Build the six-sight seed list (curated or generated) for a destination. */
export function seedSights(destination: string): Sight[] {
  const city = destination.trim();
  const key = curatedKey(city);
  const seeds = key ? CURATED[key] : generatedSeeds(city);
  return seeds.slice(0, 6).map((seed, slot) => ({
    id: `${city.toLowerCase()}:${seed.name.toLowerCase()}:${slot}`,
    name: seed.name,
    area: seed.area,
    description: seed.description,
    destination: city,
    mode: "curated" as const,
    sourceUrl: null,
    image: { kind: "attraction" as const, query: `${seed.name} ${city}`, slot },
  }));
}

/**
 * Compose the full read result. `enrich` is an injectable, per-sight live
 * overlay (e.g. a Wikipedia summary fetch); any rejection/timeout for a sight
 * leaves its curated seed intact and keeps mode "curated" (labelled fallback,
 * never throws). This keeps the module unit-testable without network access.
 */
export async function resolveSights(
  destination: string,
  enrich?: (sight: Sight) => Promise<{ description?: string; sourceUrl?: string | null } | null>,
  now: Date = new Date(),
): Promise<SightsResult> {
  const city = destination.trim();
  const base = seedSights(city);
  const sights = enrich
    ? await Promise.all(
        base.map(async (sight) => {
          try {
            const live = await enrich(sight);
            if (!live) return sight;
            return {
              ...sight,
              description: live.description?.trim() || sight.description,
              sourceUrl: live.sourceUrl ?? sight.sourceUrl,
              mode: "live" as const,
            };
          } catch {
            return sight;
          }
        }),
      )
    : base;
  return {
    destination: city,
    sights: sights.slice(0, 6),
    restriction: `Results are limited to ${city}.`,
    retrievedAt: now.toISOString(),
  };
}