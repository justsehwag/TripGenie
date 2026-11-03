/**
 * Airport resolution for live flight pricing (live-travel-pricing Req 2.1, 2.2).
 *
 * Pure module: no network, no framework imports. Maps free-text origin or
 * destination input (city name, airport name, alias, IATA code, or a
 * "City (ABC)" label) to an upper-case IATA code.
 */

export interface AirportEntry {
  /** Upper-case IATA code. */
  code: string;
  /** Lower-case, single-spaced names and aliases. */
  names: string[];
}

export const AIRPORTS: readonly AirportEntry[] = [
  // Indian metros
  { code: "DEL", names: ["delhi", "new delhi", "indira gandhi international"] },
  { code: "BOM", names: ["mumbai", "bombay", "chhatrapati shivaji maharaj international"] },
  { code: "BLR", names: ["bengaluru", "bangalore", "kempegowda international"] },
  { code: "MAA", names: ["chennai", "madras"] },
  { code: "CCU", names: ["kolkata", "calcutta"] },
  { code: "HYD", names: ["hyderabad", "secunderabad", "rajiv gandhi international"] },
  // Indian tourist and regional airports
  { code: "GOI", names: ["goa", "dabolim", "panaji", "panjim"] },
  { code: "PNQ", names: ["pune", "poona"] },
  { code: "AMD", names: ["ahmedabad"] },
  { code: "JAI", names: ["jaipur"] },
  { code: "COK", names: ["kochi", "cochin", "ernakulam"] },
  { code: "TRV", names: ["thiruvananthapuram", "trivandrum"] },
  { code: "LKO", names: ["lucknow"] },
  { code: "VNS", names: ["varanasi", "benares", "banaras"] },
  { code: "ATQ", names: ["amritsar"] },
  { code: "SXR", names: ["srinagar", "kashmir"] },
  { code: "IXL", names: ["leh", "ladakh", "leh ladakh"] },
  { code: "UDR", names: ["udaipur"] },
  { code: "BBI", names: ["bhubaneswar", "bhubaneshwar"] },
  { code: "GAU", names: ["guwahati", "gauhati"] },
  { code: "PAT", names: ["patna"] },
  { code: "IXC", names: ["chandigarh"] },
  { code: "IDR", names: ["indore"] },
  { code: "NAG", names: ["nagpur"] },
  { code: "CJB", names: ["coimbatore"] },
  { code: "IXM", names: ["madurai"] },
  { code: "IXE", names: ["mangalore", "mangaluru"] },
  { code: "VTZ", names: ["visakhapatnam", "vizag", "vishakhapatnam"] },
  { code: "IXZ", names: ["port blair", "andaman", "andaman and nicobar"] },
  { code: "IXB", names: ["bagdogra", "siliguri", "darjeeling"] },
  { code: "DED", names: ["dehradun", "rishikesh"] },
  // International hubs
  { code: "DXB", names: ["dubai", "uae", "united arab emirates", "emirates"] },
  { code: "AUH", names: ["abu dhabi"] },
  { code: "DOH", names: ["doha", "qatar"] },
  { code: "SIN", names: ["singapore", "changi"] },
  { code: "BKK", names: ["bangkok", "suvarnabhumi", "thailand", "phuket", "pattaya"] },
  { code: "KUL", names: ["kuala lumpur", "malaysia"] },
  { code: "CMB", names: ["colombo", "sri lanka"] },
  { code: "KTM", names: ["kathmandu", "nepal"] },
  { code: "MLE", names: ["male", "maldives"] },
  { code: "DPS", names: ["bali", "denpasar", "indonesia"] },
  { code: "HKG", names: ["hong kong"] },
  { code: "HND", names: ["tokyo", "haneda", "japan"] },
  { code: "SYD", names: ["sydney", "australia"] },
  { code: "LHR", names: ["london", "heathrow", "uk", "united kingdom", "england", "britain", "great britain"] },
  { code: "CDG", names: ["paris", "charles de gaulle", "france"] },
  { code: "JFK", names: ["new york", "new york city", "nyc", "usa", "united states", "united states of america", "america"] },
  // Country / major-destination aliases (primary intl airport per place)
  { code: "ZRH", names: ["zurich", "switzerland", "swiss", "zurich airport"] },
  { code: "FCO", names: ["rome", "italy", "fiumicino"] },
  { code: "BCN", names: ["barcelona", "spain"] },
  { code: "FRA", names: ["frankfurt", "germany"] },
  { code: "AMS", names: ["amsterdam", "netherlands", "holland"] },
  { code: "IST", names: ["istanbul", "turkey", "turkiye"] },
  { code: "ATH", names: ["athens", "greece"] },
  { code: "SGN", names: ["ho chi minh", "saigon", "vietnam"] },
  { code: "CAI", names: ["cairo", "egypt"] },
  { code: "MRU", names: ["mauritius"] },
  { code: "SEZ", names: ["seychelles", "mahe"] },
];

/** Trim, collapse internal whitespace runs and lower-case. */
function normalize(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

const BY_NAME: ReadonlyMap<string, string> = new Map(
  AIRPORTS.flatMap((entry) => entry.names.map((name) => [normalize(name), entry.code] as const)),
);

const BY_CODE: ReadonlySet<string> = new Set(AIRPORTS.map((entry) => entry.code));

const SUFFIX_CODE = /\(\s*([a-z]{3})\s*\)$/i;
const THREE_ALPHA = /^[a-z]{3}$/i;

/**
 * Resolve free-text input to an upper-case IATA code.
 * Resolution order: "City (ABC)" suffix -> table name -> table code -> any 3-letter alpha -> null.
 * Table names win over the bare 3-letter rule, so "Goa" -> GOI and "Leh" -> IXL.
 */
export function resolveAirport(input: string): string | null {
  if (typeof input !== "string") return null;
  const key = normalize(input);
  if (key === "") return null;

  const suffix = SUFFIX_CODE.exec(key);
  if (suffix) return suffix[1].toUpperCase();

  const byName = BY_NAME.get(key);
  if (byName) return byName;

  const upper = key.toUpperCase();
  if (BY_CODE.has(upper)) return upper;

  if (THREE_ALPHA.test(key)) return upper;

  return null;
}
