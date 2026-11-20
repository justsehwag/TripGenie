/**
 * Trips API (App Router route handler) for signed-in accounts.
 *
 * Every method goes through `withSession`: the owner is always the verified
 * Cognito `sub`, never a value from the request. Anonymous requests get 401.
 * Guests keep their drafts in the device Local_Store and never call this route.
 *
 * - GET    → the account's newest trips (up to ACCOUNT_MAX_TRIPS, currently 20)
 *            `{ trips, persisted: true, truncated }`
 * - POST   → body `{ clientDraftId, name, status?, payload, mode?, updatedAt? }`
 *     • mode "save" (default): idempotent upsert, `{ id, saved, updatedAt, pruned, persisted }`
 *     • mode "merge": create only if absent (guest merge), `{ id, created, pruned, persisted }`
 * - DELETE → `{ tripId }` in the body (or `?tripId=`); deletes the key
 *            `(sub, tripId)` only. Always `{ deleted: true }`, so existence
 *            cannot be probed.
 *
 * Errors: 400 validation, 413 payload too large, 503 when account storage is
 * not configured, otherwise a generic 500.
 */
import { getAccountStore } from "@/lib/account/store";
import {
  deleteAccountTrip,
  listAccountTrips,
  mergeGuestTrip,
  saveAccountTrip,
  TripPayloadTooLargeError,
} from "@/lib/account/trips-service";
import { validateTripInput } from "@/lib/account/validate";
import { logSafe } from "@/lib/log";
import { withSession } from "@/lib/auth/with-session";

export const dynamic = "force-dynamic";

// 350 KB payload limit plus envelope overhead.
const MAX_POST_BODY_BYTES = 360 * 1024;
const MAX_TRIP_ID = 200;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function unavailable(): Response {
  return json({ error: "Account storage is not available." }, 503);
}

function failure(event: string, err: unknown, fallback: string): Response {
  if (err instanceof TripPayloadTooLargeError) {
    return json({ error: "Payload is too large." }, 413);
  }
  logSafe(event, { name: err instanceof Error ? err.name : "UnknownError" });
  return json({ error: fallback }, 500);
}

export const GET = withSession(async ({ sub }) => {
  const store = getAccountStore();
  if (!store) return unavailable();
  try {
    const { trips, truncated } = await listAccountTrips({ store }, sub);
    return json({ trips, persisted: true, truncated }, 200);
  } catch (err) {
    return failure("trips_list_failed", err, "The saved trips could not be loaded.");
  }
});

export const POST = withSession(
  async ({ sub, body }) => {
    const store = getAccountStore();
    if (!store) return unavailable();

    const parsed = validateTripInput(body);
    if (!parsed.ok) {
      return json({ error: parsed.error }, parsed.status === 413 ? 413 : 400);
    }

    try {
      if (parsed.value.mode === "merge") {
        const result = await mergeGuestTrip({ store }, sub, parsed.value);
        return json({ ...result, persisted: true }, 200);
      }
      const result = await saveAccountTrip({ store }, sub, parsed.value);
      return json({ ...result, persisted: true }, 200);
    } catch (err) {
      return failure("trips_save_failed", err, "The trip could not be saved.");
    }
  },
  { maxBodyBytes: MAX_POST_BODY_BYTES },
);

export const DELETE = withSession(async ({ sub, body, request }) => {
  const store = getAccountStore();
  if (!store) return unavailable();

  let raw: unknown;
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    raw = (body as { tripId?: unknown }).tripId;
  }
  if (raw === undefined) {
    raw = new URL(request.url).searchParams.get("tripId") ?? undefined;
  }
  const tripId = typeof raw === "string" ? raw.trim() : "";
  if (!tripId || tripId.length > MAX_TRIP_ID) {
    return json({ error: "A tripId is required to delete a trip." }, 400);
  }

  try {
    const result = await deleteAccountTrip({ store }, sub, tripId);
    return json(result, 200);
  } catch (err) {
    return failure("trips_delete_failed", err, "The trip could not be deleted.");
  }
});
