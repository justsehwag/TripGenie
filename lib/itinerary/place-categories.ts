// Pure tables for the places-first itinerary: interest rows (Assumption c, plus the
// "beaches" alias), visit lengths (Assumption d), meal types and excluded types.

export interface InterestRow {
  /** Places API (New) types sent to Nearby Search and used as candidate categories. */
  types: readonly string[];
  /** Text Search phrases, in order. Each is sent as "<phrase> in <destination>". */
  phrases: readonly string[];
}

/** Keys are lower-cased and trimmed. "culture" and "history" share one row. */
const CULTURE_ROW: InterestRow = {
  types: ["tourist_attraction", "museum", "historical_landmark", "place_of_worship"],
  phrases: ["tourist attractions", "museums", "historical landmarks"],
};

export const INTEREST_TABLE: Readonly<Record<string, InterestRow>> = Object.freeze({
  culture: CULTURE_ROW,
  history: CULTURE_ROW,
  food: { types: ["restaurant"], phrases: ["restaurants", "local food"] },
  nature: { types: ["park", "natural_feature", "beach"], phrases: ["parks", "beaches", "nature spots"] },
  beaches: { types: ["beach"], phrases: ["beaches"] },
  shopping: { types: ["shopping_mall", "market"], phrases: ["shopping malls", "markets"] },
  nightlife: { types: ["bar", "night_club"], phrases: ["bars", "night clubs"] },
  adventure: { types: ["amusement_park", "hiking_area"], phrases: ["amusement parks", "hiking trails"] },
});

/** Used when no usable interest remains. */
export const DEFAULT_ROW: InterestRow = {
  types: ["tourist_attraction", "museum", "park", "restaurant"],
  phrases: ["tourist attractions", "museums", "parks", "restaurants"],
};

/** Own-property lookup so keys such as "constructor" are not found on the prototype. */
export function interestRow(key: string): InterestRow | undefined {
  return Object.prototype.hasOwnProperty.call(INTEREST_TABLE, key) ? INTEREST_TABLE[key] : undefined;
}

export const DEFAULT_VISIT_MINUTES = 60;

/** Suggested visit length in minutes by primary type (Assumption d). */
export const VISIT_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  tourist_attraction: 90,
  museum: 90,
  historical_landmark: 60,
  place_of_worship: 45,
  park: 60,
  natural_feature: 90,
  beach: 120,
  shopping_mall: 90,
  market: 60,
  restaurant: 60,
  bar: 90,
  night_club: 120,
  amusement_park: 180,
  hiking_area: 150,
});

/** Types that make a Stop restaurant-like, so meal windows apply. */
export const MEAL_TYPES: readonly string[] = ["restaurant"];

/** Types that are never visit Stops (Text Search for "restaurants" can return hotels). */
export const NON_VISIT_TYPES: readonly string[] = [
  "lodging",
  "hotel",
  "motel",
  "hostel",
  "airport",
  "bus_station",
  "train_station",
  "transit_station",
  "car_rental",
  "parking",
  "gas_station",
  "atm",
  "bank",
  "hospital",
  "pharmacy",
];
