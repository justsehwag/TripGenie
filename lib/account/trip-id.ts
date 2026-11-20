import { createHash } from "node:crypto";

/**
 * Deterministic trip key: "t_" + first 22 chars of base64url(SHA-256(clientDraftId)).
 * The owner is already the partition key, so it is not part of the hash input.
 * Server-only (node:crypto).
 */
export function tripIdFor(clientDraftId: string): string {
  const digest = createHash("sha256").update(clientDraftId, "utf8").digest("base64url");
  return `t_${digest.slice(0, 22)}`;
}
