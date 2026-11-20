/**
 * Preferences API (account-sync). Owner is the verified session `sub`.
 *
 * - GET -> { preferences, version }  (preferences null and version 0 when none)
 * - PUT -> body { preferences, expectedVersion }; strict validation (400 / 413),
 *          conditional write, 409 { error, currentVersion } on a stale version,
 *          503 when account storage is not configured.
 *
 * Requirements: 3.7, 6.1, 6.4, 9.1, 9.5
 */
import { withSession, type SessionContext } from "@/lib/auth/with-session";
import { getAccountStore } from "@/lib/account/store";
import { validatePreferencesRequest } from "@/lib/account/validate";
import { VersionConflictError } from "@/lib/dynamo-store";

export const dynamic = "force-dynamic";

const UNAVAILABLE = "Account storage is not available.";

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

async function handleGet(ctx: SessionContext): Promise<Response> {
  const store = getAccountStore();
  if (!store) return json({ error: UNAVAILABLE }, 503);
  const found = await store.getPreferences(ctx.sub);
  return json({ preferences: found?.data ?? null, version: found?.version ?? 0 }, 200);
}

async function handlePut(ctx: SessionContext): Promise<Response> {
  const store = getAccountStore();
  if (!store) return json({ error: UNAVAILABLE }, 503);

  const parsed = validatePreferencesRequest(ctx.body);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status ?? 400);
  const { preferences, expectedVersion } = parsed.value;

  try {
    const { version } = await store.putPreferences(ctx.sub, preferences, expectedVersion);
    return json({ preferences, version }, 200);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return json({ error: "Preferences changed in another session.", currentVersion: err.currentVersion }, 409);
    }
    throw err;
  }
}

export const GET = withSession(handleGet);
export const PUT = withSession(handlePut, { maxBodyBytes: 16 * 1024 });
