/**
 * Profiles API edge (App Router route handler) — design: Traveler Profile /
 * Data Models: Profiles table (single-item-per-user, version CAS).
 *
 * This is a THIN handler: it parses/validates the request, delegates to the
 * already-built pure+edge core in `lib/dynamo-store.ts`, and maps errors to
 * HTTP status codes. No domain logic lives here. Profile edits update the
 * stored record in place and never reopen conversational intake.
 *
 * - GET  /api/profile?userId=…      → fetch a user's profile (KvStore.getProfile)
 * - PUT|POST /api/profile           → version-checked update (updateProfile):
 *     body = { userId, expectedVersion, changes }
 *     • success        → 200 with the updated profile (version incremented)
 *     • stale version  → 409 (VersionConflictError) with the current version
 *     • anything else  → 500 (no internals leaked)
 *
 * Requirements: 7.3 (single-item-per-user profile store), 7.4 (version CAS),
 * 7.5 (stale version surfaced as HTTP 409).
 */
import {
  updateProfile,
  VersionConflictError,
  type KvStore,
} from "@/lib/dynamo-store";
import type { TravelerProfile } from "@/lib/types";
import type { StoredTrip } from "@/lib/trip-retention";

export const dynamic = "force-dynamic";

/* ---------------------------------------------------------------------------
 * Dev/demo KvStore adapter.
 *
 * When no real DynamoDB client is configured we fall back to this in-memory
 * adapter so the route works end-to-end in local dev and demos WITHOUT inventing
 * AWS credentials. It is process-local and non-durable by design. A production
 * deployment injects a DynamoDB-backed KvStore via `setProfileStore(...)` (see
 * the edge integration in Task 19/24); the trip operations here are unused by
 * the profile route and are present only to satisfy the KvStore port.
 *
 * DO NOT rely on this adapter for persistence — it exists purely as the default
 * when `TRIPGENIE_PROFILE_STORE` is not wired to a live client.
 * ------------------------------------------------------------------------- */
class InMemoryProfileStore implements KvStore {
  private readonly profiles = new Map<string, TravelerProfile>();
  private trips: StoredTrip[] = [];

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
  async getProfile(userId: string): Promise<TravelerProfile | null> {
    return this.profiles.get(userId) ?? null;
  }
  async putProfile(profile: TravelerProfile): Promise<void> {
    this.profiles.set(profile.userId, profile);
  }
}

// Module-level, injectable accessor. Defaults to the dev adapter; a real
// DynamoDB-backed KvStore can be injected at startup via setProfileStore().
let store: KvStore = new InMemoryProfileStore();

/** Inject a live KvStore (e.g. DynamoDB-backed) in place of the dev adapter. */
export function setProfileStore(next: KvStore): void {
  store = next;
}

/** Fields a caller may change; userId and version are controlled by the core. */
type ProfileChanges = Partial<Omit<TravelerProfile, "userId" | "version">>;

interface UpdateBody {
  userId?: unknown;
  expectedVersion?: unknown;
  changes?: unknown;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function GET(request: Request): Promise<Response> {
  const userId = new URL(request.url).searchParams.get("userId")?.trim();
  if (!userId) {
    return json({ error: "userId is required" }, 400);
  }
  try {
    const profile = await store.getProfile(userId);
    if (!profile) {
      return json({ error: "Profile not found" }, 404);
    }
    return json({ profile }, 200);
  } catch {
    // Never leak internal error detail to the caller.
    return json({ error: "Internal error" }, 500);
  }
}

async function handleUpdate(request: Request): Promise<Response> {
  let body: UpdateBody;
  try {
    body = (await request.json()) as UpdateBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  const expectedVersion = body.expectedVersion;
  const changes = body.changes;

  if (!userId) {
    return json({ error: "userId is required" }, 400);
  }
  if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 0) {
    return json({ error: "expectedVersion must be a non-negative integer" }, 400);
  }
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
    return json({ error: "changes must be an object" }, 400);
  }

  try {
    const current = await store.getProfile(userId);
    if (!current) {
      return json({ error: "Profile not found" }, 404);
    }
    // Delegate the compare-and-swap to the core; it throws on a stale version
    // and leaves the store unchanged.
    const updated = await updateProfile(
      store,
      current,
      expectedVersion as number,
      changes as ProfileChanges,
    );
    return json({ profile: updated }, 200);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      // Req 7.5: stale version → HTTP 409 with the current version.
      return json(
        {
          error: "Profile changed in another session",
          currentVersion: err.currentVersion,
        },
        409,
      );
    }
    // Any other failure maps to 500 without leaking internals.
    return json({ error: "Internal error" }, 500);
  }
}

export async function PUT(request: Request): Promise<Response> {
  return handleUpdate(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleUpdate(request);
}
