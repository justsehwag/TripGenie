/**
 * Profile API (account-sync). The owner is always the verified session `sub`;
 * there is no userId parameter.
 *
 * - GET            -> { profile, version }  (profile null and version 0 when none)
 * - PUT | POST     -> body { expectedVersion, changes }
 *     - version 0 with no stored profile creates it (every field required)
 *     - 200 { profile, version } on success
 *     - 409 { error, currentVersion } on a stale version
 *     - 400 on an invalid body, 503 when account storage is not configured
 *
 * Requirements: 2.2, 2.3, 6.1, 6.4, 6.6, 6.7, 9.1, 9.5
 */
import { withSession, type SessionContext } from "@/lib/auth/with-session";
import { getAccountStore } from "@/lib/account/store";
import { validateProfileRequest } from "@/lib/account/validate";
import { VersionConflictError } from "@/lib/dynamo-store";
import type { TravelerProfile } from "@/lib/types";

export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

const UNAVAILABLE = "Account storage is not available.";

function conflict(currentVersion: number): Response {
  return json({ error: "Profile changed in another session.", currentVersion }, 409);
}

async function handleGet(ctx: SessionContext): Promise<Response> {
  const store = getAccountStore();
  if (!store) return json({ error: UNAVAILABLE }, 503);
  const profile = await store.getProfile(ctx.sub);
  return json({ profile, version: profile?.version ?? 0 }, 200);
}

async function handleWrite(ctx: SessionContext): Promise<Response> {
  const store = getAccountStore();
  if (!store) return json({ error: UNAVAILABLE }, 503);

  const current = await store.getProfile(ctx.sub);
  const parsed = validateProfileRequest(ctx.body, { requireAll: current === null });
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { expectedVersion, changes } = parsed.value;

  const currentVersion = current?.version ?? 0;
  if (expectedVersion !== currentVersion) return conflict(currentVersion);

  const next = {
    ...(current ?? {}),
    ...changes,
    userId: ctx.sub,
    version: currentVersion + 1,
  } as TravelerProfile;

  try {
    await store.putProfile(next);
  } catch (err) {
    if (err instanceof VersionConflictError) return conflict(err.currentVersion);
    throw err;
  }
  return json({ profile: next, version: next.version }, 200);
}

export const GET = withSession(handleGet);
export const PUT = withSession(handleWrite);
export const POST = withSession(handleWrite);
