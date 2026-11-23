import { MAX_TRIP_DAYS } from "./itinerary/constants";
import { endFromDays } from "./itinerary/trip-dates";
import { isIsoDate } from "./quick-form";

export interface TripPreviewInput {
  where?: string; // raw "Where to" text, e.g. "Goa from Delhi"
  destination?: string; // context destination wins when set
  origin?: string;
  startDate?: string; // ISO or ""
  days?: number; // day count from How long
  travellers?: number;
  vibe?: string;
}

export interface TripPreview {
  place: string;
  dates: string;
  travellers: string;
  vibe: string;
  text: string;
  endDate: string | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Fri 12 Dec" for a valid ISO date, "" otherwise. Uses UTC parts only. */
export function formatShortDate(iso: string): string {
  try {
    if (typeof iso !== "string" || !isIsoDate(iso)) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return "";
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(d.getTime())) return "";
    return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  } catch {
    return "";
  }
}

/** Splits "X from Y" into destination X and origin Y. */
export function parseWhereTo(text: string): { destination: string; origin: string } {
  const t = typeof text === "string" ? text.trim() : "";
  const m = /^(.*?)\s+from\s+(.*)$/i.exec(t);
  if (m) {
    const destination = m[1].trim();
    const origin = m[2].trim();
    if (destination && origin) return { destination, origin };
  }
  return { destination: t, origin: "" };
}

function clean(s: unknown): string {
  return typeof s === "string" ? s.trim() : "";
}

function dayLabel(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

export function formatTripPreview(i: TripPreviewInput): TripPreview {
  try {
    const input = i ?? {};
    const parsed = parseWhereTo(clean(input.where));
    const destination = clean(input.destination) || parsed.destination;
    const origin = clean(input.origin) || parsed.origin;
    const place = destination ? (origin ? `${destination} from ${origin}` : destination) : "";

    const rawDays = input.days;
    const days =
      typeof rawDays === "number" && Number.isFinite(rawDays) && Math.floor(rawDays) >= 1
        ? Math.min(MAX_TRIP_DAYS, Math.floor(rawDays))
        : null;
    const start = typeof input.startDate === "string" && isIsoDate(input.startDate) ? input.startDate : "";
    const startLabel = start ? formatShortDate(start) : "";

    let dates = "";
    let endDate: string | null = null;
    if (startLabel && days !== null) {
      const end = endFromDays(start, days);
      const endLabel = formatShortDate(end);
      if (endLabel) {
        endDate = end;
        dates = days === 1 ? `${startLabel} · ${dayLabel(1)}` : `${startLabel} – ${endLabel} · ${dayLabel(days)}`;
      }
    } else if (startLabel) {
      dates = startLabel;
    } else if (days !== null) {
      dates = `${dayLabel(days)} · dates not set`;
    }

    const t = input.travellers;
    const travellers =
      typeof t === "number" && Number.isFinite(t) && Math.floor(t) >= 1
        ? `${Math.floor(t)} ${Math.floor(t) === 1 ? "traveller" : "travellers"}`
        : "";
    const vibe = clean(input.vibe);

    const text = [place, dates, travellers, vibe].filter(Boolean).join(" · ");
    return { place, dates, travellers, vibe, text, endDate };
  } catch {
    return { place: "", dates: "", travellers: "", vibe: "", text: "", endDate: null };
  }
}
