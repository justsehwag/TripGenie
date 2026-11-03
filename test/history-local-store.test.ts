// Feature: account-history-and-drafts, Property 1: Local_Store is device-only (sentinel owner)
// Feature: account-history-and-drafts, Property 3: Local_Store retention and idempotency
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  localApplySave,
  localRetainNewest,
} from "@/lib/history/local-store";
import { LOCAL_OWNER } from "@/lib/history/scope";
import type { SaveInput, StoredTrip } from "@/lib/trip-retention";

/**
 * Property 1: Local_Store is device-only (sentinel owner).
 * Property 3: Local_Store retention + idempotency + sensitive stripping.
 *
 * These exercise the pure Local_Store cores (`localApplySave`,
 * `localRetainNewest`) against sequences of `SaveInput` values. The returned
 * trips are chained as `existing` into the next save so collisions on
 * `clientDraftId` exercise the idempotent update-in-place path.
 *
 * Validates: Requirements 2.2, 3.2, 3.4, 3.5, 4.2, 4.8, 5.3, 5.5, 7.1, 7.4
 */

// The sensitive-key substrings mirrored from `stripSensitive` in trip-retention.
const SENSITIVE_SUBSTRINGS = [
  "payment",
  "card",
  "cvv",
  "passport",
  "pan",
  "ssn",
  "auth",
  "token",
  "secret",
];

function hasSensitiveKey(payload: Record<string, unknown>): boolean {
  return Object.keys(payload).some((k) => {
    const lower = k.toLowerCase();
    return SENSITIVE_SUBSTRINGS.some((s) => lower.includes(s));
  });
}

// Owner arbitrary: includes real-looking userIds, so the test proves that even
// when a caller supplies a genuine userId it is forced to the sentinel.
const ownerArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant("user-1234"),
  fc.constant("auth0|abcdef012345"),
  fc.constant("google-oauth2|99887766"),
  fc.constant(""),
  fc.constant(LOCAL_OWNER),
  fc.string(),
);

// A small set of clientDraftIds so collisions happen and exercise idempotency.
const clientDraftIdArb: fc.Arbitrary<string> = fc.constantFrom(
  "draft-A",
  "draft-B",
  "draft-C",
);

// Safe payload keys that must survive stripping.
const safeKeyArb: fc.Arbitrary<string> = fc.constantFrom(
  "destination",
  "notes",
  "days",
  "budget",
  "travelers",
);

// Sensitive payload keys that MUST be stripped before persist.
const sensitiveKeyArb: fc.Arbitrary<string> = fc.constantFrom(
  "paymentCard",
  "authToken",
  "passportNo",
  "cvv",
  "ssn",
  "apiSecret",
  "panNumber",
);

// Payload that sometimes includes sensitive keys alongside safe ones.
const payloadArb: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    fc.dictionary(safeKeyArb, fc.jsonValue(), { maxKeys: 5 }),
    fc.dictionary(sensitiveKeyArb, fc.jsonValue(), { maxKeys: 4 }),
  )
  .map(([safe, sensitive]) => ({ ...safe, ...sensitive }));

const saveInputArb: fc.Arbitrary<SaveInput> = fc.record(
  {
    owner: ownerArb,
    clientDraftId: clientDraftIdArb,
    name: fc.string(),
    status: fc.option(fc.string(), { nil: undefined }),
    payload: payloadArb,
    ttl: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: undefined }),
  },
  { requiredKeys: ["owner", "clientDraftId", "name", "payload"] },
);

// Apply a sequence of saves, chaining trips as `existing`. Uses increasing
// `now` timestamps so `updatedAt` ordering is deterministic and distinct.
function applySequence(inputs: SaveInput[]): StoredTrip[] {
  let trips: StoredTrip[] = [];
  const base = Date.UTC(2024, 0, 1, 0, 0, 0);
  inputs.forEach((input, i) => {
    const now = new Date(base + i * 1000);
    const result = localApplySave(trips, input, `new-id-${i}`, now);
    trips = result.trips;
  });
  return trips;
}

describe("Feature: account-history-and-drafts, Local_Store cores", () => {
  it("Property 1: Local_Store is device-only (sentinel owner)", () => {
    fc.assert(
      fc.property(fc.array(saveInputArb, { minLength: 1, maxLength: 12 }), (inputs) => {
        const trips = applySequence(inputs);
        // Every resulting record is owned by the sentinel, never a real userId.
        for (const t of trips) {
          expect(t.owner).toBe(LOCAL_OWNER);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Property 3: Local_Store retention and idempotency", () => {
    fc.assert(
      fc.property(fc.array(saveInputArb, { minLength: 1, maxLength: 12 }), (inputs) => {
        const trips = applySequence(inputs);
        const kept = localRetainNewest(trips);

        // (a) at most 5 records kept, newest by updatedAt desc.
        expect(kept.length).toBeLessThanOrEqual(5);
        for (let i = 1; i < kept.length; i++) {
          expect(kept[i - 1].updatedAt >= kept[i].updatedAt).toBe(true);
        }
        // kept is the newest slice of all trips sorted by updatedAt desc.
        const allDesc = trips
          .slice()
          .sort((a, b) =>
            a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
          )
          .slice(0, 5);
        expect(kept.map((t) => t.tripId)).toEqual(allDesc.map((t) => t.tripId));

        // (b) idempotency: the number of distinct records never exceeds the
        // number of distinct clientDraftIds in the input (re-saves update in
        // place rather than growing the count).
        const distinctDraftIds = new Set(inputs.map((i) => i.clientDraftId));
        expect(trips.length).toBeLessThanOrEqual(distinctDraftIds.size);
        // tripIds are unique (no duplicate records for the same draft).
        expect(new Set(trips.map((t) => t.tripId)).size).toBe(trips.length);

        // (c) no sensitive key survives in any persisted payload.
        for (const t of trips) {
          expect(hasSensitiveKey(t.payload)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
