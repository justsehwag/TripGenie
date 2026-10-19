import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { applySave, retainNewest, stripSensitive, type StoredTrip } from "@/lib/trip-retention";
import { applyProfileUpdate, deriveFareBasis } from "@/lib/profile";
import type { TravelerProfile } from "@/lib/types";

/** Feature: tripgenie - retention/profile property tests (Properties 31-34, 11). */

const owner = "USER#1";

describe("Feature: tripgenie, trip retention", () => {
  it("Property 31: Trip saves are idempotent on client draft identifier", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (repeats) => {
        let trips: StoredTrip[] = [];
        for (let i = 0; i < repeats; i++) {
          const r = applySave(trips, { owner, clientDraftId: "draft-A", name: "Trip", payload: { n: i } }, `new-${i}`);
          trips = r.trips;
        }
        const mine = trips.filter((t) => t.owner === owner && t.clientDraftId === "draft-A");
        expect(mine.length).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  it("Property 32: Trip store retains only the five newest trips", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), (n) => {
        const trips: StoredTrip[] = Array.from({ length: n }, (_, i) => ({
          tripId: `t-${i}`,
          owner,
          clientDraftId: `d-${i}`,
          name: "X",
          status: "ready",
          payload: {},
          createdAt: `2027-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
          updatedAt: `2027-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        }));
        const { kept, deleted } = retainNewest(owner, trips);
        expect(kept.length).toBe(Math.min(5, n));
        expect(deleted.length).toBe(Math.max(0, n - 5));
      }),
      { numRuns: 100 },
    );
  });

  it("Property 33: Stored trip records exclude sensitive traveler data", () => {
    fc.assert(
      fc.property(fc.string(), (val) => {
        const cleaned = stripSensitive({ city: "Goa", payment: val, passport: val, authToken: val });
        expect("payment" in cleaned).toBe(false);
        expect("passport" in cleaned).toBe(false);
        expect("authToken" in cleaned).toBe(false);
        expect(cleaned.city).toBe("Goa");
      }),
      { numRuns: 100 },
    );
  });

  it("Property 34: Session and draft records always carry a time-to-live", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9999999999 }), (ttl) => {
        const { trips } = applySave([], { owner, clientDraftId: "d1", name: "T", payload: {}, ttl }, "id1");
        expect(trips[0].ttl).toBe(ttl);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: tripgenie, fare derivation (Req 7.1, 7.2)", () => {
  const profile: TravelerProfile = {
    userId: "U1",
    displayName: "Asha",
    homeCity: "Delhi",
    travelStyle: "Balanced",
    locale: "en-IN",
    party: { adults: 2, children: 1 },
    version: 1,
  };

  it("derives per-person and party fares and hotel nights from the profile", () => {
    const basis = deriveFareBasis(profile, 4999.4, 3);
    expect(basis.perPerson).toBe(4999);
    expect(basis.party).toBe(4999 * 3);
    expect(basis.hotelNights).toBe(3);
  });

  it("floors party size to one and nights to one for degenerate inputs", () => {
    const solo: TravelerProfile = { ...profile, party: { adults: 0, children: 0 } };
    const basis = deriveFareBasis(solo, -10, 0);
    expect(basis.perPerson).toBe(0);
    expect(basis.party).toBe(0);
    expect(basis.hotelNights).toBe(1);
  });
});

describe("Feature: tripgenie, profile CAS", () => {
  const base: TravelerProfile = {
    userId: "U1",
    displayName: "Asha",
    homeCity: "Delhi",
    travelStyle: "Balanced",
    locale: "en-IN",
    party: { adults: 2, children: 0 },
    version: 3,
  };

  it("Property 11: Profile compare-and-swap rejects stale versions", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), (expected) => {
        const r = applyProfileUpdate(base, expected, { homeCity: "Mumbai" });
        if (expected === base.version) {
          expect(r.ok).toBe(true);
          if (r.ok) {
            expect(r.profile.version).toBe(base.version + 1);
            expect(r.profile.homeCity).toBe("Mumbai");
          }
        } else {
          expect(r.ok).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
