/**
 * Curated, lightweight travel "did you know" lines shown while an itinerary is
 * drafting. Keyed by a normalised destination substring; a generic pool is used
 * when nothing matches. Pure data + a pure selector, so it is safe anywhere and
 * never fabricates per-trip claims (the lines are general facts/tips, not
 * promises about the user's specific booking).
 */

/** Fun, broadly-true facts for popular destinations (substring match on name). */
const BY_DESTINATION: ReadonlyArray<{ match: string[]; facts: string[] }> = [
  {
    match: ["goa"],
    facts: [
      "Goa has over 100 km of coastline and more than 30 beaches.",
      "Goa was a Portuguese territory for about 450 years, until 1961.",
      "Try the Goan classics: fish curry rice, prawn balchao and bebinca.",
      "The best weather is November to February - warm, dry and breezy.",
    ],
  },
  {
    match: ["bali", "denpasar"],
    facts: [
      "Bali is known as the Island of the Gods and has thousands of temples.",
      "Balinese names often reflect birth order - Wayan, Made, Nyoman, Ketut.",
      "The rice terraces of Jatiluwih are a UNESCO World Heritage site.",
      "Nyepi, Bali's Day of Silence, pauses the whole island for 24 hours.",
    ],
  },
  {
    match: ["tokyo", "japan"],
    facts: [
      "Tokyo is the world's most populous metropolitan area.",
      "Shibuya Crossing can see over 2,500 people cross at once.",
      "Japan has more than 4 million vending machines.",
      "Tokyo has more Michelin-starred restaurants than any other city.",
    ],
  },
  {
    match: ["paris", "france"],
    facts: [
      "The Eiffel Tower grows about 15 cm taller in summer heat.",
      "Paris has around 130 museums - the Louvre is the most visited on earth.",
      "There are only two stop signs in the whole city of Paris.",
      "Croissants are actually Austrian in origin, not French.",
    ],
  },
  {
    match: ["dubai", "uae", "abu dhabi"],
    facts: [
      "The Burj Khalifa is over 828 m tall - the world's tallest building.",
      "Dubai's police fleet includes supercars like the Bugatti Veyron.",
      "About 85% of Dubai's residents were born outside the UAE.",
      "The Dubai Mall is one of the largest shopping centres in the world.",
    ],
  },
  {
    match: ["singapore"],
    facts: [
      "Singapore is one of only three surviving city-states in the world.",
      "The Gardens by the Bay Supertrees are up to 50 m tall.",
      "Chewing gum sales have been restricted in Singapore since 1992.",
      "It is one of the greenest cities on earth, by design.",
    ],
  },
  {
    match: ["bangkok", "thailand"],
    facts: [
      "Bangkok's full ceremonial name is the longest city name in the world.",
      "Thailand is the only Southeast Asian country never colonised by Europe.",
      "Street food here is so good it has earned Michelin recognition.",
      "The wai - palms together - is the traditional Thai greeting.",
    ],
  },
  {
    match: ["maldives", "male"],
    facts: [
      "The Maldives is the lowest-lying country on earth.",
      "It is made up of around 1,200 coral islands in 26 atolls.",
      "Some resorts glow at night from bioluminescent plankton.",
      "Each resort typically occupies its own private island.",
    ],
  },
  {
    match: ["switzerland", "zurich", "geneva", "interlaken"],
    facts: [
      "Switzerland has over 1,500 lakes - you're never far from water.",
      "It has four national languages: German, French, Italian and Romansh.",
      "The Swiss eat more chocolate per person than almost anyone.",
      "Trains here are famously punctual - set your watch by them.",
    ],
  },
  {
    match: ["new york", "nyc", "usa"],
    facts: [
      "New York City is made up of five boroughs and over 800 languages.",
      "Central Park is larger than the entire country of Monaco.",
      "The subway runs 24 hours a day, every day of the year.",
      "Times Square was once called Longacre Square.",
    ],
  },
  {
    match: ["london", "uk", "england"],
    facts: [
      "The London Underground is the world's oldest metro, opened in 1863.",
      "Big Ben is the bell, not the clock tower.",
      "London has more than 170 museums, many of them free.",
      "Black cab drivers memorise 320 routes for 'The Knowledge'.",
    ],
  },
  {
    match: ["kerala", "kochi", "cochin", "munnar", "alleppey"],
    facts: [
      "Kerala's backwaters stretch about 900 km of linked lagoons and canals.",
      "It is nicknamed God's Own Country for its lush greenery.",
      "Kerala has one of India's highest literacy rates.",
      "A houseboat cruise on the backwaters is the classic way to see it.",
    ],
  },
  {
    match: ["jaipur", "rajasthan", "udaipur", "jodhpur"],
    facts: [
      "Jaipur is called the Pink City - its old town was painted pink in 1876.",
      "Rajasthan is home to the Thar, India's largest desert.",
      "Udaipur is known as the Venice of the East for its lakes.",
      "Jodhpur's old town glows blue beneath the Mehrangarh Fort.",
    ],
  },
];

/** Generic travel facts and tips used when no destination matches. */
const GENERIC: readonly string[] = [
  "Packing tip: roll your clothes instead of folding to save space.",
  "A short walk on arrival helps reset your body clock faster.",
  "Carry a refillable bottle - many airports now have fountains past security.",
  "Screenshot your bookings in case you lose signal at the destination.",
  "The longest non-stop flight in the world is nearly 19 hours.",
  "Booking mid-week departures is often cheaper than weekends.",
  "Learning just 'hello' and 'thank you' locally goes a long way.",
  "A photo of your checked bag helps if it ever goes missing.",
];

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Pick the fact list for a destination: the matching curated set when the name
 * contains a known keyword, otherwise the generic pool. Always returns a
 * non-empty array so the loader always has something to show.
 */
export function factsFor(destination: string | undefined | null): string[] {
  const d = norm(destination ?? "");
  if (d) {
    for (const entry of BY_DESTINATION) {
      if (entry.match.some((m) => d.includes(m))) return [...entry.facts];
    }
  }
  return [...GENERIC];
}