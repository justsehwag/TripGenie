/**
 * Wire types for the Trip Assistant. Types only: no runtime code and no
 * imports from server modules (type-only imports from lib/types.ts).
 */
import type { Itinerary, TripContext, TripDay } from "../types";

export interface ChatTurn {
  role: "user" | "assistant";
  /** <= 1000 chars for user turns, <= 4000 for assistant turns. */
  text: string;
}

export interface ProfileSubset {
  firstName?: string;
  homeCity?: string;
  travelStyle?: string;
  party?: { adults: number; children: number };
}

export interface OfferedPlace {
  placeId: string;
  name: string;
}

/** Trip-context fields shared with the model (budget level, diet, pace, interests included). */
export type AssistantContext = Pick<
  TripContext,
  | "origin"
  | "destination"
  | "durationDays"
  | "travellers"
  | "budgetLevel"
  | "diet"
  | "pace"
  | "interests"
>;

export interface WireStop {
  time: string;
  title: string;
  description: string;
  cost: number;
  priceSource?: "ai" | "estimated" | "web";
  sourceHost?: string;
  checkedAt?: string;
  placeId?: string;
  placeName?: string;
  area?: string;
  location?: { lat: number; lng: number };
  openingHours?: string;
  hoursLabel?: "Typical hours" | "Hours not listed";
  travelToNextMin?: number;
  visitMin?: number;
}

export interface WireDay {
  day: number;
  date: string;
  title: string;
  theme: string;
  total: number;
  dayTrip?: true;
  activities: WireStop[];
}

/** 1..30 days, 0..20 stops per day. */
export interface WireItinerary {
  title: string;
  totalCost: number;
  days: WireDay[];
}

export interface PlaceRecord {
  placeId: string;
  name: string;
  address: string;
  area?: string;
  location: { lat: number; lng: number };
  mapsUrl: string;
  photoRef?: string;
  photos?: string[];
  openingHours?: string;
  hoursLabel?: "Typical hours" | "Hours not listed";
  rating?: number;
  visitMin?: number;
}

export interface CitedPriceRecord {
  inr: number;
  sourceUrl: string;
  sourceHost: string;
  checkedAt: string;
  basis: string;
}

export type EditOp =
  | { op: "add"; day: number; index?: number; time?: string; placeId: string }
  | { op: "replace"; day: number; index: number; expectTitle: string; placeId: string }
  | { op: "remove"; day: number; index: number; expectTitle: string }
  | {
      op: "move";
      day: number;
      index: number;
      expectTitle: string;
      toDay: number;
      toIndex?: number;
      time?: string;
    }
  | { op: "retime"; day: number; index: number; expectTitle: string; time: string };

export interface EditProposal {
  version: 1;
  /** Random, unique within the response. */
  id: string;
  /** One sentence, <= 200 chars. */
  summary: string;
  edit: EditOp;
  /** Present for add and replace; filled by the server from a fresh lookup. */
  place?: PlaceRecord;
  /** Present only when a Cited_Price exists. */
  price?: CitedPriceRecord;
}

/** A web source the reply cites through an [S#] marker. https only. */
export interface SourceLink {
  /** Marker id such as "S1". */
  ref: string;
  host: string;
  url: string;
  title?: string;
  checkedAt?: string;
}

export interface AssistantRequest {
  /** 1..1000 chars. */
  message: string;
  /** Client sends at most 10; server trims to 10 again. */
  history: ChatTurn[];
  itinerary: WireItinerary;
  context: AssistantContext;
  profile?: ProfileSubset;
  /** At most 30. */
  offered?: OfferedPlace[];
}

export interface AssistantResponse {
  reply: string;
  /** 0..5 */
  proposals: EditProposal[];
  sources: SourceLink[];
  offered: OfferedPlace[];
  status: "ok" | "partial" | "unavailable";
  degraded: Array<"bedrock" | "places" | "web">;
}

export interface AppliedEdit {
  before: Itinerary;
  after: Itinerary;
  summary: string;
  at: number;
}

/** Newest last, capped at 50. */
export type HistoryState = { entries: AppliedEdit[] };

export interface Preview {
  dayBefore: TripDay | null;
  dayAfter: TripDay | null;
  dayTotalDelta: number;
  tripTotalDelta: number;
}
