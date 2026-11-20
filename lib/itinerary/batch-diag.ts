// Counts-only diagnostic line for a batch that built no day. Kept in its own
// small module so the main (places-first) flow does not pull in the retired
// verifier through batch-service.ts. batch-service.ts re-exports everything here.
// Numbers and fixed words only: no place names, queries, keys or errors.

export const BATCH_LOG_TAG = "[itinerary-batch]";
export const BATCH_DIAG_TAG = "[itinerary-batch-diag]";

export type DiagCause = "parse" | "verify" | "lookup";

export interface DiagInput {
  cause: DiagCause;
  parseLen: number;
  truncated: boolean;
  prefilter: number;
  duplicate: number;
  lookupFailed: number;
  noMatch: number;
  outside: number;
  tooFew: number;
}

function int(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** Numbers and fixed words only: no place names, queries, keys or errors. */
export function formatBatchDiag(d: DiagInput): string {
  return (
    `${BATCH_DIAG_TAG} cause=${d.cause} prefilter=${int(d.prefilter)} duplicate=${int(d.duplicate)}` +
    ` lookupFailed=${int(d.lookupFailed)} noMatch=${int(d.noMatch)} outside=${int(d.outside)}` +
    ` tooFew=${int(d.tooFew)} parseLen=${int(d.parseLen)} truncated=${d.truncated === true}`
  );
}
