import type { Promotion } from "./types";

/**
 * Promotions Engine (pure) — design section "10. Promotions Engine".
 * Ported from TripSaathi lib/promotions.ts (applyPromotion).
 * Computed separately from base fares; deterministic; never alters gross.
 * Requirements: 8.5-8.7.
 */
export const promotions: Promotion[] = [
  { code: "GENIE500", kind: "coupon", discount: 500, minSpend: 10000 },
  { code: "FREQ750", kind: "loyalty", discount: 750, minSpend: 20000 },
  { code: "PRICE1000", kind: "bounty", discount: 1000, minSpend: 30000 },
  { code: "DELIGHT300", kind: "delight", discount: 300, minSpend: 7500 },
];

export interface PromotionResult {
  total: number;
  discount: number;
  payable: number;
  offer?: Promotion;
  error: string;
}

/** Deterministic pure function of (gross, code); never mutates gross (Req 8.5-8.7). */
export function applyPromotion(total: number, code?: string): PromotionResult {
  const offer = promotions.find((item) => item.code === code);
  if (!offer)
    return { total, discount: 0, payable: total, error: code ? "Coupon not found" : "" };
  if (total < offer.minSpend)
    return {
      total,
      discount: 0,
      payable: total,
      error: `Minimum spend is INR ${offer.minSpend}`,
    };
  const discount = Math.min(total, offer.discount);
  return { total, discount, payable: total - discount, offer, error: "" };
}
