// SERVER-ONLY. Do not import from a "use client" module: this file pulls in the
// AWS SDK through the DynamoDB account store.
//
// Wires the account store from the environment. Table names are read from
// process.env at call time (accountStorageConfigured), not from awsConfig.tables,
// because awsConfig has non-empty defaults and cannot signal "not configured".
// Routes call getAccountStore() and return 503 "Account storage is not
// available." when it returns null.
import { createDynamoAccountStore, type AccountStore } from "./dynamo-account-store";
import { accountStorageConfigured } from "./env";

let cached: AccountStore | null = null;
let override: AccountStore | null | undefined;

/** The account store, or null when account storage is not configured. */
export function getAccountStore(): AccountStore | null {
  if (override !== undefined) return override;
  if (!accountStorageConfigured()) return null;
  if (!cached) cached = createDynamoAccountStore();
  return cached;
}

/** Test hook: inject a store, or null to simulate "not configured". */
export function setAccountStoreForTests(store: AccountStore | null): void {
  override = store;
}

/** Test hook: drop the injected store and the lazily built instance. */
export function resetAccountStoreForTests(): void {
  override = undefined;
  cached = null;
}
