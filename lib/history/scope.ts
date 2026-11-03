import type { IdentitySession } from "@/lib/identity";

/**
 * Scope: the data-ownership boundary for history and drafts.
 * Pure and node-testable — this module never touches `window` and never
 * imports a server-only secret.
 */
export type Scope =
  | { kind: "guest" }
  | { kind: "signed-in"; userId: string };

/** Owner string used for Local_Store records; never a real userId. */
export const LOCAL_OWNER = "@local" as const;

/**
 * Resolve the Scope from an already-parsed identity session.
 *
 * Returns a guest scope when the session is null, carries no `userId`, or
 * carries a `userId` whose trimmed value is empty; otherwise a signed-in
 * scope with the trimmed `userId` (Req 2.6, 7.1, 7.2, 7.4, 7.5).
 */
export function resolveScope(session: IdentitySession | null): Scope {
  const userId = session?.userId;
  if (typeof userId !== "string") {
    return { kind: "guest" };
  }
  const trimmed = userId.trim();
  if (trimmed === "") {
    return { kind: "guest" };
  }
  return { kind: "signed-in", userId: trimmed };
}

/** The owner value a given scope uses when persisting records. */
export function scopeOwner(scope: Scope): string {
  return scope.kind === "signed-in" ? scope.userId : LOCAL_OWNER;
}
