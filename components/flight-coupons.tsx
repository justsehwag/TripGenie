import { promotions } from "@/lib/promotions";
import type { Promotion } from "@/lib/types";
import { inr } from "@/components/flight-offer-card";

/**
 * "Unlock a lower trip price" strip for the Flights results page.
 *
 * Every card is generated from the REAL Promotions Engine table
 * (`lib/promotions.ts`), so each code, discount and minimum spend shown here is
 * exactly what `applyPromotion` will honour. Nothing is invented: if a
 * promotion is added or removed in the engine, this strip follows.
 */

const TITLE: Record<Promotion["kind"], string> = {
  coupon: "Welcome coupon",
  loyalty: "Frequent traveller",
  bounty: "Price-drop bounty",
  delight: "TripGenie Delight",
};

function describe(p: Promotion): string {
  const off = inr.format(p.discount);
  const min = inr.format(p.minSpend);
  switch (p.kind) {
    case "coupon":
      return `${off} off your first eligible trip over ${min}`;
    case "loyalty":
      return `${off} loyalty saving on trips over ${min}`;
    case "bounty":
      return `Up to ${off} off when your trip total is over ${min}`;
    case "delight":
      return `${off} surprise saving on journeys over ${min}`;
  }
}

function SparkleIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3zM18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function FlightCoupons() {
  if (promotions.length === 0) return null;
  return (
    <section className="flight-coupons" aria-labelledby="flight-coupons-title">
      <header className="flight-coupons__head">
        <span className="flight-coupons__icon">
          <SparkleIcon />
        </span>
        <div>
          <h2 id="flight-coupons-title" className="flight-coupons__title">
            Unlock a lower trip price
          </h2>
          <p className="flight-coupons__lead">
            Coupons, frequent-traveller rewards, price-drop bounties and customer
            delights. Each code applies to eligible trip totals.
          </p>
        </div>
      </header>
      <ul className="flight-coupons__grid">
        {promotions.map((p) => (
          <li key={p.code} className="flight-coupon">
            <p className="flight-coupon__code">{p.code}</p>
            <p className="flight-coupon__name">{TITLE[p.kind]}</p>
            <p className="flight-coupon__desc">{describe(p)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}