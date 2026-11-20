import { describe, expect, it } from "vitest";
import { readBatchResponse } from "@/lib/itinerary/batch-wire";
import { sanitizeStoredVerification } from "@/lib/itinerary/revalidate";
import { sanitizeStoredItinerary } from "@/lib/web-price-sources";

const PHOTO = (n: number) => `places/ChIJabc/photos/p${n}`;
const DETAIL = {
  text: "Book ahead on weekends.",
  sourceUrl: "https://example.com/tips",
  sourceHost: "example.com",
  checkedAt: "2025-01-02T03:04:05.000Z",
};

function act(extra: Record<string, unknown> = {}): any {
  return { time: "09:00", title: "Louvre", description: "Art.", cost: 20, ...extra };
}

function response(activities: any[]): any {
  return {
    source: "model",
    fromDay: 1,
    dayCount: 1,
    days: [{ day: 1, title: "Day one", activities }],
    verifiedDays: [1],
    withheldDays: [],
    truncated: false,
    stats: { proposed: 1, verified: 1, removed: 0, ms: 5 },
  };
}

const itin = (activities: any[]): any => ({ days: [{ day: 1, title: "d", activities }] });

const good = () =>
  act({
    openingHours: "Monday: 9:00 AM – 6:00 PM",
    hoursLabel: "Typical hours",
    photos: [PHOTO(1), PHOTO(2)],
    webDetails: { checked: true, tip: { ...DETAIL }, priceKind: "entry" },
  });

describe("new Activity fields: wire", () => {
  it("passes valid new fields through unchanged", () => {
    const body = response([good()]);
    const r = readBatchResponse(JSON.parse(JSON.stringify(body)));
    expect(r?.days[0].activities[0]).toEqual(good());
  });

  it("round-trips through JSON", () => {
    const r1 = readBatchResponse(response([good()]));
    const r2 = readBatchResponse(JSON.parse(JSON.stringify(r1)));
    expect(r2).toEqual(r1);
  });

  it("a response without the new fields keeps the same day objects", () => {
    const body = response([act()]);
    const r = readBatchResponse(body);
    expect(r?.days[0]).toBe(body.days[0]);
  });

  it("drops each invalid new field alone and keeps the Stop", () => {
    const r = readBatchResponse(
      response([
        act({ openingHours: 5, hoursLabel: "Open late", photos: ["bad"], webDetails: "x" }),
      ]),
    );
    expect(r?.days[0].activities[0]).toEqual(act());
  });

  it("keeps at most 3 valid photos and drops invalid names", () => {
    const r = readBatchResponse(
      response([act({ photos: [PHOTO(1), "nope", PHOTO(2), PHOTO(3), PHOTO(4)] })]),
    );
    expect((r?.days[0].activities[0] as any).photos).toEqual([PHOTO(1), PHOTO(2), PHOTO(3)]);
  });

  it("drops an invalid Web_Detail but keeps the valid ones", () => {
    const r = readBatchResponse(
      response([
        act({
          webDetails: {
            checked: true,
            tip: { ...DETAIL },
            booking: { ...DETAIL, sourceUrl: "http://example.com/x" },
            bestTime: { ...DETAIL, checkedAt: "not a date" },
          },
        }),
      ]),
    );
    const w = (r?.days[0].activities[0] as any).webDetails;
    expect(w).toEqual({ checked: true, tip: DETAIL });
    expect(r?.days[0].activities[0].title).toBe("Louvre");
  });
});

describe("new Activity fields: stored itinerary", () => {
  it("returns the same object when the new fields are valid", () => {
    const input = itin([good()]);
    expect(sanitizeStoredVerification(input)).toBe(input);
    expect(sanitizeStoredItinerary(input)).toEqual(input);
  });

  it("drops invalid fields alone, keeps the Stop, and is idempotent", () => {
    const input = itin([
      act({
        openingHours: "",
        hoursLabel: 3,
        photos: [PHOTO(1), "x", PHOTO(2), PHOTO(3), PHOTO(4)],
        webDetails: { checked: true, tip: { ...DETAIL, sourceUrl: "ftp://x" } },
      }),
    ]);
    const out = sanitizeStoredItinerary(input);
    expect(out.days[0].activities[0]).toEqual(
      act({ photos: [PHOTO(1), PHOTO(2), PHOTO(3)], webDetails: { checked: true } }),
    );
    expect(sanitizeStoredItinerary(out)).toEqual(out);
    expect(sanitizeStoredVerification(out)).toBe(out);
  });

  it("drops webDetails whose checked flag is not a boolean", () => {
    const out = sanitizeStoredVerification(itin([act({ webDetails: { checked: "yes" } })]));
    expect(out.days[0].activities[0]).toEqual(act());
  });
});
