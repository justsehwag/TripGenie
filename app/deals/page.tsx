import DealsClient, {
  type BookableOffer,
  type DealsCategory,
  type EditorialItem,
} from "@/components/deals-client";
import { buildCarOffers, buildFlightOffers, buildStayOffers } from "@/lib/inventory-adapter";
import { applyPromotion } from "@/lib/promotions";
import { serializeCriteria } from "@/lib/search-criteria";
import type { CarOffer, FlightOffer, OfferMeta, StayOffer } from "@/lib/types";

/**
 * Deals_Page (Req 26) — server shell + client category filter.
 *
 * The page is a server component that assembles two strictly separated bodies of
 * content and hands them to the `DealsClient` for category filtering (Req 26.3/
 * 26.4 need client interactivity, the shell does not):
 *
 *   • EDITORIAL recommendations — featured destinations and seasonal inspiration.
 *     These are non-bookable ideas. They carry NO price, NO provenance, and NO
 *     savings (Req 26.1/26.2).
 *   • BOOKABLE offers — stays / flights / cars produced by the Inventory_Adapter.
 *     Every offer is `estimated` by default and is labelled with its `OfferMeta`
 *     provenance (Req 26.5). A savings value is attached ONLY when the
 *     Promotions_Engine (`applyPromotion`) actually produces a discount for that
 *     offer's gross — otherwise none is shown and none is fabricated (Req 26.6).
 *
 * Selecting a bookable offer navigates to the matching Results_Page
 * (`/stays` | `/flights` | `/cars`) with its `Search_Criteria` serialized into
 * the query string (Req 26.7), so opening the link reproduces the search.
 *
 * The Global_Navigation and Site_Footer are rendered by app/layout.tsx, so the
 * footer appears here too (Req 26.8) — this page must NOT render its own footer.
 */

export const metadata = { title: "TripGenie - Deals and inspiration" };

// Deterministic "now" is irrelevant to correctness here; the adapter only uses
// it for retrievedAt/expiresAt timestamps rendered in the provenance label.

// ---------------------------------------------------------------------------
// Categories — one "All" plus the three bookable categories. Editorial items
// are tagged with the same categories so a selection filters both bodies.
// ---------------------------------------------------------------------------

const CATEGORIES: DealsCategory[] = ["all", "stays", "flights", "cars"];

// ---------------------------------------------------------------------------
// Editorial content (non-bookable) — featured destinations + seasonal ideas.
// Grouped into the two required editorial sections; each is tagged with the
// booking category it inspires so the category control filters it too.
// ---------------------------------------------------------------------------

const FEATURED: EditorialItem[] = [
  {
    id: "feat-goa",
    group: "featured",
    category: "stays",
    title: "Goa",
    blurb: "Slow coastal mornings, palm-lined lanes, and long golden-hour dinners.",
  },
  {
    id: "feat-kyoto",
    group: "featured",
    category: "flights",
    title: "Kyoto",
    blurb: "Temple gardens, quiet tea houses, and maple light in the old quarter.",
  },
  {
    id: "feat-lisbon",
    group: "featured",
    category: "cars",
    title: "Lisbon",
    blurb: "Tiled hills, Atlantic breezes, and an easy coastal drive to Sintra.",
  },
  {
    id: "feat-udaipur",
    group: "featured",
    category: "stays",
    title: "Udaipur",
    blurb: "Lake palaces, old-city rooftops, and unhurried evenings on the water.",
  },
];

const SEASONAL: EditorialItem[] = [
  {
    id: "seas-paris",
    group: "seasonal",
    category: "flights",
    title: "Paris in spring",
    blurb: "Chestnut blossom along the Seine and gardens easing back into colour.",
  },
  {
    id: "seas-bali",
    group: "seasonal",
    category: "stays",
    title: "Bali dry season",
    blurb: "Clear skies and calm surf — the kindest window for rice-terrace walks.",
  },
  {
    id: "seas-dubai",
    group: "seasonal",
    category: "cars",
    title: "Dubai cool months",
    blurb: "Mild desert evenings made for a self-drive dune road and the coast.",
  },
];

// ---------------------------------------------------------------------------
// Bookable offers — assembled from the Inventory_Adapter (estimated by default)
// with a serialized Results_Page link and, when and only when the
// Promotions_Engine produces one, a savings value.
// ---------------------------------------------------------------------------

/** A seasonal promo code per category; a savings value is shown only if it applies. */
const PROMO_CODE: Record<"stays" | "flights" | "cars", string> = {
  stays: "GENIE500",
  flights: "PRICE1000",
  cars: "DELIGHT300",
};

/**
 * Compute a savings value for a bookable offer's gross. The ONLY source of a
 * discount is the Promotions_Engine (`applyPromotion`). When the gross is below
 * the promotion's minimum spend (or the code does not apply), `applyPromotion`
 * returns a zero discount — in that case we attach NO savings, so nothing is
 * fabricated (Req 26.6).
 */
function savingsFor(
  gross: number,
  category: "stays" | "flights" | "cars",
): BookableOffer["savings"] {
  const result = applyPromotion(gross, PROMO_CODE[category]);
  if (result.discount <= 0 || !result.offer) return undefined;
  return { amount: result.discount, code: result.offer.code, payable: result.payable };
}

/** Flatten an OfferMeta into the serializable provenance the client renders. */
function provenance(meta: OfferMeta): BookableOffer["provenance"] {
  return {
    provider: meta.provider,
    mode: meta.mode,
    retrievedAt: meta.retrievedAt,
    expiresAt: meta.expiresAt,
    disclaimer: meta.disclaimer,
  };
}

function stayOffer(o: StayOffer): BookableOffer {
  const gross = o.pricePerNight * Math.max(1, o.nights);
  const href = `/stays?${serializeCriteria({
    category: "stays",
    destination: o.destination,
    checkIn: "",
    checkOut: "",
    guests: 2,
    rooms: 1,
  })}`;
  return {
    id: o.id,
    category: "stays",
    title: `${o.destination} · ${o.stayStyle} stay`,
    detail: `${o.nights} night${o.nights === 1 ? "" : "s"}`,
    priceLabel: `INR ${o.pricePerNight.toLocaleString("en-IN")} / night`,
    gross,
    href,
    provenance: provenance(o.meta),
    savings: savingsFor(gross, "stays"),
  };
}

function flightOffer(o: FlightOffer): BookableOffer {
  const gross = o.farePerPerson;
  const href = `/flights?${serializeCriteria({
    category: "flights",
    tripType: "round-trip",
    origin: o.origin,
    destination: o.destination,
    departDate: "",
    returnDate: "",
    travellers: 1,
    cabin: o.cabin,
  })}`;
  return {
    id: o.id,
    category: "flights",
    title: `${o.origin} → ${o.destination}`,
    detail: `${o.cabin} · ${o.stops === 0 ? "non-stop" : `${o.stops} stop`}`,
    priceLabel: `INR ${o.farePerPerson.toLocaleString("en-IN")} / person`,
    gross,
    href,
    provenance: provenance(o.meta),
    savings: savingsFor(gross, "flights"),
  };
}

function carOffer(o: CarOffer): BookableOffer {
  const gross = o.pricePerDay * Math.max(1, o.days);
  const href = `/cars?${serializeCriteria({
    category: "cars",
    pickupLocation: o.pickupLocation,
    pickupDate: "",
    pickupTime: "",
    returnDate: "",
    returnTime: "",
    driverAge: 25,
  })}`;
  return {
    id: o.id,
    category: "cars",
    title: `${o.carClass} car · ${o.pickupLocation}`,
    detail: `${o.transmission} · ${o.seats} seats · ${o.days} day${o.days === 1 ? "" : "s"}`,
    priceLabel: `INR ${o.pricePerDay.toLocaleString("en-IN")} / day`,
    gross,
    href,
    provenance: provenance(o.meta),
    savings: savingsFor(gross, "cars"),
  };
}

/** Build the bookable offer set from the Inventory_Adapter (estimated path). */
function buildOffers(): BookableOffer[] {
  const stays = [
    ...buildStayOffers({ origin: "Delhi", destination: "Goa", cabin: "economy", stayStyle: "Luxury", nights: 4 }, 2),
    ...buildStayOffers({ origin: "Delhi", destination: "Bali", cabin: "economy", stayStyle: "Comfort", nights: 5 }, 1),
  ].map(stayOffer);

  const flights = [
    ...buildFlightOffers({ origin: "Delhi", destination: "Paris", cabin: "Business", stayStyle: "Comfort", nights: 5 }, 2),
    ...buildFlightOffers({ origin: "Mumbai", destination: "Tokyo", cabin: "Economy", stayStyle: "Comfort", nights: 6 }, 1),
  ].map(flightOffer);

  const cars = buildCarOffers(
    { origin: "", destination: "Dubai", cabin: "economy", stayStyle: "Comfort", nights: 3, carClass: "SUV", rentalDays: 3 },
    3,
  ).map(carOffer);

  return [...stays, ...flights, ...cars];
}

export default function DealsPage() {
  const editorial = [...FEATURED, ...SEASONAL];
  const offers = buildOffers();

  return (
    <DealsClient categories={CATEGORIES} editorial={editorial} offers={offers} />
  );
}
