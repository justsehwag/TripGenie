/**
 * Booking edge with DynamoDB-backed idempotency - design section 14.
 * Backs the one-use token / at-most-once order with a conditional put keyed
 * on the idempotency key. The pure booking core (Task 10) owns the reprice/state.
 * Requirements: 12.4, 12.5, 12.6.
 */

/**
 * A conditional-put port: `putIfAbsent` returns true iff the key was not
 * already present (mirrors DynamoDB attribute_not_exists).
 */
export interface IdempotencyStore {
  putIfAbsent(key: string, orderId: string): Promise<boolean>;
  get(key: string): Promise<string | null>;
}

export interface ConfirmOutcome {
  orderId: string;
  deduped: boolean;
}

/**
 * Execute a confirmed order at most once per idempotency key. The first call
 * wins the conditional put and executes; duplicates return the same order
 * with deduped=true and never place a second order (Req 12.4-12.6).
 */
export async function confirmOnce(
  store: IdempotencyStore,
  idempotencyKey: string,
  makeOrderId: () => string,
): Promise<ConfirmOutcome> {
  const orderId = makeOrderId();
  const won = await store.putIfAbsent(idempotencyKey, orderId);
  if (won) return { orderId, deduped: false };
  const existing = await store.get(idempotencyKey);
  return { orderId: existing ?? orderId, deduped: true };
}
