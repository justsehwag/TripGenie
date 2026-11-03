// Feature: account-history-and-drafts, Property 2: Scope resolver correctness
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveScope } from "@/lib/history/scope";
import type { IdentitySession } from "@/lib/identity";

/**
 * Property 2: Scope resolver correctness.
 *
 * For any session value, `resolveScope` returns `{ kind: "guest" }` EXACTLY
 * when the session is null, carries no `userId`, or carries a `userId` whose
 * trimmed value is empty; otherwise it returns `{ kind: "signed-in", userId }`
 * with the trimmed `userId`.
 *
 * Validates: Requirements 2.6, 7.2, 7.5
 */

// A userId arbitrary that exercises the interesting classes:
// - empty strings
// - whitespace-only strings (trim to empty -> guest)
// - padded strings with leading/trailing spaces (trim to non-empty -> signed-in)
// - ordinary non-empty strings
const userIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("\t\n  "),
  // padded around an arbitrary core (core may itself be empty/whitespace)
  fc
    .tuple(
      fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { maxLength: 3 }),
      fc.string(),
      fc.stringOf(fc.constantFrom(" ", "\t", "\n"), { maxLength: 3 }),
    )
    .map(([lead, core, trail]) => `${lead}${core}${trail}`),
  fc.string(),
);

// Arbitrary that yields:
// - null
// - objects WITHOUT a userId field (userId absent entirely)
// - objects WITH a userId field (string, per the arbitrary above)
// Non-userId fields (firstName/email) are mixed in to ensure they do not
// influence the guest/signed-in split.
const sessionArb: fc.Arbitrary<IdentitySession | null> = fc.oneof(
  fc.constant(null),
  // No userId: build from optional firstName/email only.
  fc
    .record(
      {
        firstName: fc.option(fc.string(), { nil: undefined }),
        email: fc.option(fc.string(), { nil: undefined }),
      },
      { requiredKeys: [] },
    )
    .map((o) => o as unknown as IdentitySession | null),
  // With userId.
  fc
    .record(
      {
        userId: userIdArb,
        firstName: fc.option(fc.string(), { nil: undefined }),
        email: fc.option(fc.string(), { nil: undefined }),
      },
      { requiredKeys: ["userId"] },
    )
    .map((o) => o as unknown as IdentitySession | null),
);

describe("Feature: account-history-and-drafts, scope resolver", () => {
  it("Property 2: Scope resolver correctness", () => {
    fc.assert(
      fc.property(sessionArb, (session) => {
        const rawUserId = (session as { userId?: unknown } | null)?.userId;
        const hasStringUserId = typeof rawUserId === "string";
        const trimmed = hasStringUserId ? (rawUserId as string).trim() : "";
        const expectGuest = session === null || !hasStringUserId || trimmed === "";

        const scope = resolveScope(session);

        if (expectGuest) {
          expect(scope).toEqual({ kind: "guest" });
        } else {
          expect(scope.kind).toBe("signed-in");
          // Signed-in userId equals the trimmed input and is never empty.
          expect(scope).toEqual({ kind: "signed-in", userId: trimmed });
          if (scope.kind === "signed-in") {
            expect(scope.userId).toBe(trimmed);
            expect(scope.userId.length).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
