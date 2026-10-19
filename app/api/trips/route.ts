/**
 * Trips API edge (App Router route handler) — design section 15 (Trip Store,
 * DynamoDB) and Data Models: Trips table. Requirements 13.2–13.5.
 *
 * This is a THIN handler. It parses/validates the request, delegates to the
 * already-built pure+edge core in `lib/dynamo-store.ts` (`saveTrip`,
 * `listNewest`) — which itself wraps the pure retention/idempotency core in
 * `lib/trip-retention.ts` — and maps results to JSON. No domain logic lives
 * here: idempotency by `clientDraftId`, newest-5 retention, and sensitive-field
 * stripping are all owned by the core.
 *
 * - POST /api/trips  → idempotent save (SaveInput → SaveResult)
 *     body = { owner, clientDraftId, name, status?, payload, ttl? }
 *       • signed-in (owner present) → persist via `saveTrip`, return SaveResult
 *       • anonymous (no owner)      → 200 with { persisted:false }; the draft
 *         stays browser-local and NEVER reaches DynamoDB (Req 13.1)
 * - GET /api/trips?owner=…  → the owner's newest five trips via `listNewest`
 *       • anonymous (no owner)      → 200 with { trips:[], persisted:false }
 * - DELETE /api/trips  → owner-scoped delete of a single saved trip (Req 27.6)
 *     body = { owner, tripId }
 *       • signed-in (owner present) → delete ONLY that owner's trip via the
 *         store's `deleteTrips(owner, [tripId])`, which can never touch another
 *         traveler's data; return { deleted:true }
 *       • anonymous (no owner)      → 403; an anonymous caller has no server
 *         persisted trip to delete (Req 13.1)
 *
 * Server-side validation rejects malformed input before it reaches the store.
 * Sensitive fields are stripped by the core (`stripSensitive`, Req 13.6).
 */
import {
  listNewest,
  saveTrip,
  type KvStore,
  type SaveResult,
} from "@/lib/dynamo-store";
import type { SaveInput, StoredTrip } from "@/lib/trip-retention";
import type { TravelerProfile } from "@/lib/types";

export const dynamic = "force-dynamic";

/* ---------------------------------------------------------------------------
 * Dev/demo KvStore adapter.
 *
 * There is NO live DynamoDB-backed KvStore wired yet. When no real client is
 * configured we fall back to this in-memory adapter so the route works
 * end-to-end in local dev and demos WITHOUT inventing AWS credentials or a fake
 * persistent store. It is process-local and non-durable BY DESIGN — restarting
 * the server loses all data. A production deployment injects a DynamoDB-backed
 * KvStore (conditional writes on `owner-draft`, newest query on `owner-updated`,
 * native TTL on `ttl`; see the edge integration in Task 19) via `setTripStore`.
 *
 * DO NOT treat this adapter as persistence or as a real conditional-write
 * client — it exists purely as the default until a live client is contracted.
 * ------------------------------------------------------------------------- */
class InMemoryTripStore implements KvStore {
  private trips: StoredTrip[] = [];
  private readonly profiles = new Map<string, TravelerProfile>();

  async listTrips(owner: string): Promise<StoredTrip[]> {
    return this.trips.filter((t) => t.owner === owner);
  }
  async putTrip(trip: StoredTrip): Promise<void> {
    this.trips = this.trips.filter(
      (t) => !(t.owner === trip.owner && t.tripId === trip.tripId),
    );
    this.trips.push(trip);
  }
  async deleteTrips(owner: string, tripIds: string[]): Promise<void> {
    const ids = new Set(tripIds);
    this.trips = this.trips.filter(
      (t) => !(t.owner === owner && ids.has(t.tripId)),
    );
  }
  // Profile operations are unused by the trips route; present only to satisfy
  // the KvStore port.
  async getProfile(userId: string): Promise<TravelerProfile | null> {
    return this.profiles.get(userId) ?? null;
  }
  async putProfile(profile: TravelerProfile): Promise<void> {
    this.profiles.set(profile.userId, profile);
  }
}

// Module-level, injectable accessor. Defaults to the dev adapter; a real
// DynamoDB-backed KvStore can be injected at startup via setTripStore().
let store: KvStore = new InMemoryTripStore();

/** Inject a live KvStore (e.g. DynamoDB-backed) in place of the dev adapter. */
export function setTripStore(next: KvStore): void {
  store = next;
}

// Validation bounds mirror the Trips table design (name ≤ 80 chars) and the
// ported TripSaathi handler (clientDraftId ≤ 100 chars).
const MAX_NAME = 80;
const MAX_DRAFT_ID = 100;

function json(body: unknown, status: number): Response {
  // Trips are user-scoped and must never be shared or cached across callers.
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface SaveBody {
  owner?: unknown;
  clientDraftId?: unknown;
  name?: unknown;
  status?: unknown;
  payload?: unknown;
  ttl?: unknown;
}

type ParsedSave =
  | { kind: "anonymous" }
  | { kind: "save"; input: SaveInput }
  | { kind: "error"; error: string };

/** Validate a POST body into a SaveInput, or flag anonymous / invalid input. */
function parseSave(body: SaveBody): ParsedSave {
  const owner = trimmedString(body.owner);
  // Anonymous callers (no owner) never reach DynamoDB (Req 13.1): their drafts
  // stay browser-local. Short-circuit before any validation of save fields.
  if (!owner) return { kind: "anonymous" };

  const clientDraftId = trimmedString(body.clientDraftId);
  if (!clientDraftId) {
    return { kind: "error", error: "A clientDraftId is required to save a trip." };
  }
  if (clientDraftId.length > MAX_DRAFT_ID) {
    return { kind: "error", error: `clientDraftId must be ${MAX_DRAFT_ID} characters or fewer.` };
  }

  const name = trimmedString(body.name);
  if (!name) {
    return { kind: "error", error: "A trip name is required to save a trip." };
  }
  if (name.length > MAX_NAME) {
    return { kind: "error", error: `The trip name must be ${MAX_NAME} characters or fewer.` };
  }

  if (
    body.payload === null ||
    typeof body.payload !== "object" ||
    Array.isArray(body.payload)
  ) {
    return { kind: "error", error: "The trip payload must be an object." };
  }

  if (body.status !== undefined && typeof body.status !== "string") {
    return { kind: "error", error: "The trip status must be a text value." };
  }

  let ttl: number | undefined;
  if (body.ttl !== undefined) {
    if (typeof body.ttl !== "number" || !Number.isFinite(body.ttl)) {
      return { kind: "error", error: "The ttl must be a numeric epoch-seconds value." };
    }
    ttl = Math.trunc(body.ttl);
  }

  const input: SaveInput = {
    owner,
    clientDraftId,
    name,
    status: typeof body.status === "string" ? body.status : undefined,
    // The core strips sensitive keys (Req 13.6); pass the payload as-is.
    payload: body.payload as Record<string, unknown>,
    ttl,
  };
  return { kind: "save", input };
}

export async function POST(request: Request): Promise<Response> {
  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return json({ error: "The request body must be valid JSON." }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "A trip save body is required." }, 400);
  }

  const parsed = parseSave(body);

  if (parsed.kind === "error") {
    return json({ error: parsed.error }, 400);
  }

  if (parsed.kind === "anonymous") {
    // Req 13.1: anonymous drafts are retained in browser-local memory and are
    // never persisted server-side. Signal that to the client without touching
    // the store.
    return json(
      { persisted: false, reason: "Anonymous drafts stay browser-local; sign in to save." },
      200,
    );
  }

  try {
    const result: SaveResult = await saveTrip(store, parsed.input, crypto.randomUUID());
    return json({ ...result, persisted: true }, 200);
  } catch {
    // Never leak internal error detail to the caller.
    return json({ error: "The trip could not be saved." }, 500);
  }
}

export async function GET(request: Request): Promise<Response> {
  const owner = new URL(request.url).searchParams.get("owner")?.trim() ?? "";
  // Req 13.1: without an owner there is nothing persisted server-side.
  if (!owner) {
    return json({ trips: [], persisted: false }, 200);
  }

  try {
    const trips = await listNewest(store, owner);
    return json({ trips, persisted: true }, 200);
  } catch {
    return json({ error: "The saved trips could not be loaded." }, 500);
  }
}

interface DeleteBody {
  owner?: unknown;
  tripId?: unknown;
}

/**
 * DELETE /api/trips — owner-scoped delete of a single saved trip (Req 27.6).
 *
 * Validates { owner, tripId }: an `owner` is required (an anonymous caller has
 * nothing persisted server-side to delete — 403), and a `tripId` is required
 * (400). The delete is routed through the store's `deleteTrips(owner, [tripId])`,
 * which is scoped to the owner's partition, so a caller can NEVER delete another
 * traveler's trip even by guessing an id. The handler introduces no domain
 * logic — it only parses, validates, and delegates.
 */
export async function DELETE(request: Request): Promise<Response> {
  let body: DeleteBody;
  try {
    body = (await request.json()) as DeleteBody;
  } catch {
    return json({ error: "The request body must be valid JSON." }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "A delete body is required." }, 400);
  }

  const owner = trimmedString(body.owner);
  // Req 13.1 / 27.6: only a signed-in owner has a server-persisted trip; an
  // anonymous caller may never delete server-side data.
  if (!owner) {
    return json({ error: "Sign in to delete a saved trip." }, 403);
  }

  const tripId = trimmedString(body.tripId);
  if (!tripId) {
    return json({ error: "A tripId is required to delete a trip." }, 400);
  }

  try {
    // Owner-scoped: the store deletes only this owner's matching trip.
    await store.deleteTrips(owner, [tripId]);
    return json({ deleted: true }, 200);
  } catch {
    return json({ error: "The trip could not be deleted." }, 500);
  }
}
