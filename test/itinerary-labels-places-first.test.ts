import { describe, it, expect } from "vitest";
import {
  NO_PRICE_TEXT,
  NO_TIP_TEXT,
  NO_BOOKING_TEXT,
  NO_BEST_TIME_TEXT,
  NOT_CHECKED_TEXT,
  HOURS_NOT_LISTED,
  TYPICAL_HOURS,
  TRUST_SENTENCE,
  unpricedLabel,
  priceBadgeText,
} from "@/lib/itinerary/labels";
import { priceLabel } from "@/lib/itinerary-inr";

const BANNED = /confirmed|bookable|guaranteed|100% accurate/i;

describe("places-first labels", () => {
  it("has the exact missing-value texts", () => {
    expect(NO_PRICE_TEXT).toBe("No price found online");
    expect(NO_TIP_TEXT).toBe("No tip found online");
    expect(NO_BOOKING_TEXT).toBe("No booking information found online");
    expect(NO_BEST_TIME_TEXT).toBe("No best time found online");
    expect(NOT_CHECKED_TEXT).toBe("Not checked");
    expect(HOURS_NOT_LISTED).toBe("Hours not listed");
    expect(TYPICAL_HOURS).toBe("Typical hours");
  });

  it("rewords the trust sentence without a guarantee claim", () => {
    expect(TRUST_SENTENCE).toBe(
      "Places come from Google Maps. Opening hours, availability and prices can change, so check before you go.",
    );
  });

  it("unpricedLabel includes zero and pluralises nothing", () => {
    expect(unpricedLabel(0)).toBe("0 without a web price");
    expect(unpricedLabel(1)).toBe("1 without a web price");
    expect(unpricedLabel(3)).toBe("3 without a web price");
    expect(unpricedLabel(NaN)).toBe("0 without a web price");
    expect(unpricedLabel(-2)).toBe("0 without a web price");
  });

  it("priceBadgeText says Web estimate for places-first stops and keeps legacy text", () => {
    expect(priceBadgeText({ priceSource: "web", webDetails: {} })).toBe("Web estimate");
    expect(priceBadgeText({ priceSource: "web" })).toBe(priceLabel("web"));
    expect(priceBadgeText({ priceSource: "ai" })).toBe(priceLabel("ai"));
    expect(priceBadgeText({ priceSource: "estimated" })).toBe(priceLabel("estimated"));
    expect(priceBadgeText({})).toBe(priceLabel(undefined));
  });

  it("no new text makes a banned claim", () => {
    const texts = [
      NO_PRICE_TEXT, NO_TIP_TEXT, NO_BOOKING_TEXT, NO_BEST_TIME_TEXT, NOT_CHECKED_TEXT,
      HOURS_NOT_LISTED, TYPICAL_HOURS, TRUST_SENTENCE, unpricedLabel(2),
      priceBadgeText({ priceSource: "web", webDetails: {} }),
    ];
    for (const t of texts) expect(BANNED.test(t)).toBe(false);
  });
});
