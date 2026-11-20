/**
 * Browser call to POST /api/ai with action "itinerary-batch".
 *
 * Client-safe: imports only the wire contract. Never throws; a non-ok status,
 * network error, abort, timeout or unreadable body all return null (the state
 * machine's `network-error`).
 */
import { readBatchResponse } from "@/lib/itinerary/batch-wire";
import type { BatchRequest, BatchResponse } from "@/lib/itinerary/batch-wire";
import { BATCH_CLIENT_TIMEOUT_MS } from "@/lib/itinerary/constants";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function postBatch(
  req: BatchRequest,
  signal: AbortSignal,
  fetchImpl?: FetchLike,
  timeoutMs: number = BATCH_CLIENT_TIMEOUT_MS,
): Promise<BatchResponse | null> {
  const internal = new AbortController();
  const onAbort = () => internal.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal.aborted) internal.abort();
    else signal.addEventListener("abort", onAbort);
    timer = setTimeout(() => internal.abort(), timeoutMs);

    // Resolves null when the internal signal aborts, even if fetch ignores it.
    const aborted = new Promise<null>((resolve) => {
      if (internal.signal.aborted) resolve(null);
      else internal.signal.addEventListener("abort", () => resolve(null), { once: true });
    });

    const work = (async (): Promise<BatchResponse | null> => {
      const doFetch: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
      const res = await doFetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
        cache: "no-store",
        signal: internal.signal,
      });
      if (!res || !res.ok) return null;
      const json: unknown = await res.json();
      return readBatchResponse(json);
    })();
    work.catch(() => null); // avoid unhandled rejection if the race is lost

    return await Promise.race([work, aborted]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
