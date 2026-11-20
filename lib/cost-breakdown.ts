import { formatInr } from "./itinerary-inr";

export type CostLineKey =
  | "flights"
  | "stay"
  | "activities"
  | "transport"
  | "misc"
  | "discount";

export interface CostLine {
  key: CostLineKey;
  label: string;
  formula: string;
  amountInr: number | null;
  source: string;
  included: boolean;
  note?: string;
}

export interface CostBreakdownInput {
  travellers: number;
  travellersSource: "context" | "state";
  rooms: number;
  roomsDerived: boolean;
  nights: number;
  hasFlights: boolean;
  flight: {
    amountInr: number | null;
    basis: "per-person" | "party-total";
    source: string;
  } | null;
  stay: { rateInr: number | null; source: string } | null;
  activities: {
    amountInr: number;
    webPricedCount: number;
    unpricedStopCount: number;
  };
  routeFare: {
    minInr: number;
    maxInr: number;
    mode: string;
    source: string;
    selected: boolean;
  } | null;
  misc: { sumInr: number; source: string } | null;
  discount: { code: string; amountInr: number } | null;
}

export interface CostBreakdown {
  travellersLine: string;
  roomsAssumption: string | null;
  lines: CostLine[];
  totalInr: number;
  totalLabel: "Estimated total (priced items only)";
}

export const FORBIDDEN_CERTAINTY_WORDS: readonly string[] = [
  "confirmed",
  "bookable",
  "guaranteed",
  "100% accurate",
];

function clampInt(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 1;
  return Math.max(1, v);
}

/** Whole INR for a valid non-negative finite amount, otherwise null (unpriced). */
function money(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function src(s: unknown, fallback: string): string {
  return typeof s === "string" && s.trim() ? s.trim() : fallback;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildCostBreakdown(input: CostBreakdownInput): CostBreakdown {
  const travellers = clampInt(input.travellers);
  const rooms = clampInt(input.rooms);
  const nights = clampInt(input.nights);
  const lines: CostLine[] = [];

  // Flights
  if (input.hasFlights) {
    const f = input.flight;
    const amt = f ? money(f.amountInr) : null;
    if (f && amt !== null) {
      if (f.basis === "per-person") {
        lines.push({
          key: "flights",
          label: "Flights",
          formula: `${formatInr(amt)} per person × ${plural(travellers, "traveller", "travellers")}`,
          amountInr: Math.round(amt * travellers),
          source: src(f.source, "Live flight search"),
          included: true,
          note: "live",
        });
      } else {
        lines.push({
          key: "flights",
          label: "Flights",
          formula: `${formatInr(amt)} party total, as returned by the flight API`,
          amountInr: amt,
          source: src(f.source, "Live flight search"),
          included: true,
          note: "live",
        });
      }
    } else {
      lines.push({
        key: "flights",
        label: "Flights: not priced",
        formula: "No live flight price available",
        amountInr: null,
        source: "",
        included: false,
        note: "not priced",
      });
    }
  }

  // Stay
  const rate = input.stay ? money(input.stay.rateInr) : null;
  if (input.stay && rate !== null) {
    lines.push({
      key: "stay",
      label: "Stay",
      formula: `${formatInr(rate)} × ${plural(nights, "night", "nights")} × ${plural(rooms, "room", "rooms")}`,
      amountInr: Math.round(rate * nights * rooms),
      source: src(input.stay.source, "Live hotel search"),
      included: true,
      note: "live",
    });
  } else {
    lines.push({
      key: "stay",
      label: "Stay: not priced",
      formula: "No live hotel rate available",
      amountInr: null,
      source: "",
      included: false,
      note: "not priced",
    });
  }

  // Activities
  const act = input.activities;
  const actAmt = act ? money(act.amountInr) : null;
  if (act && actAmt !== null) {
    const web = Math.max(0, Math.floor(Number(act.webPricedCount) || 0));
    const unpriced = Math.max(0, Math.floor(Number(act.unpricedStopCount) || 0));
    lines.push({
      key: "activities",
      label: "Activities",
      formula: `person-basis × travellers; group-basis × ceil(travellers / 4); ${web} web-priced`,
      amountInr: actAmt,
      source: web > 0 ? "Web prices and estimates" : "Estimates",
      included: true,
      note: unpriced > 0 ? `${plural(unpriced, "stop", "stops")} not priced` : undefined,
    });
  }

  // Transport
  const rf = input.routeFare;
  if (rf) {
    const min = money(rf.minInr);
    const maxRaw = money(rf.maxInr);
    const mode = src(rf.mode, "road/rail");
    if (min === null) {
      lines.push({
        key: "transport",
        label: `Transport (${mode}): not priced`,
        formula: "No valid fare available",
        amountInr: null,
        source: "",
        included: false,
        note: "not priced",
      });
    } else if (rf.selected) {
      lines.push({
        key: "transport",
        label: `Transport (${mode})`,
        formula: `from ${formatInr(min)} (lowest listed fare)`,
        amountInr: min,
        source: src(rf.source, "Listed fare"),
        included: true,
      });
    } else {
      const max = maxRaw !== null && maxRaw >= min ? maxRaw : min;
      lines.push({
        key: "transport",
        label: `Transport (${mode})`,
        formula: `${formatInr(min)} to ${formatInr(max)}`,
        amountInr: min,
        source: src(rf.source, "Listed fare"),
        included: false,
        note: "not included in total",
      });
    }
  }

  // Misc
  if (input.misc) {
    const sum = money(input.misc.sumInr);
    if (sum !== null && sum > 0) {
      lines.push({
        key: "misc",
        label: "Misc",
        formula: `${formatInr(sum)} across days with web prices`,
        amountInr: sum,
        source: src(input.misc.source, "Web prices"),
        included: false,
        note: "not included in total",
      });
    }
  }

  // Discount
  const disc = input.discount ? money(input.discount.amountInr) : null;
  if (input.discount && disc !== null && disc > 0) {
    lines.push({
      key: "discount",
      label: `Discount (${src(input.discount.code, "coupon")})`,
      formula: `minus ${formatInr(disc)}`,
      amountInr: disc,
      source: `Coupon ${src(input.discount.code, "applied")}`,
      included: false,
      note: "subtracted from total",
    });
  }

  let sum = 0;
  for (const l of lines) {
    if (l.included && l.amountInr !== null) sum += l.amountInr;
  }
  const totalInr = Math.max(0, Math.round(sum - (disc ?? 0)));

  return {
    travellersLine: `Travellers: ${travellers} (${
      input.travellersSource === "context" ? "from trip details" : "from planner setting"
    })`,
    roomsAssumption: input.roomsDerived ? "rooms = ceil(travellers / 2)" : null,
    lines,
    totalInr,
    totalLabel: "Estimated total (priced items only)",
  };
}
