/**
 * XP route handlers with injected dependencies (testable). The Next route file
 * app/api/xp/route.ts wires the real store and limiter. Owner is ctx.sub only.
 */
import type { SessionContext } from "../auth/with-session";
import type { Limiter } from "../assistant/rate-limit";
import { logSafe } from "../log";
import type { AccountStore } from "./dynamo-account-store";
import { awardXp, readXp, validateAward, XpConflictError } from "./xp-service";

export interface XpHandlerDeps {
  getStore: () => AccountStore | null;
  limiter: Limiter;
}

const UNAVAILABLE = "Account storage is not available.";

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers });
}

export function createXpHandlers(deps: XpHandlerDeps) {
  async function handleGet(ctx: SessionContext): Promise<Response> {
    const store = deps.getStore();
    if (!store) return json({ error: UNAVAILABLE }, 503);
    try {
      const state = await readXp(store, ctx.sub);
      return json({ total: state.total, awarded: state.awarded }, 200);
    } catch (err) {
      logSafe("xp_get_error", { name: err instanceof Error ? err.name : "UnknownError" });
      return json({ error: UNAVAILABLE }, 503);
    }
  }

  async function handlePost(ctx: SessionContext): Promise<Response> {
    const limit = deps.limiter.allow(ctx.sub);
    if (!limit.ok) {
      return json({ error: "Too many requests." }, 429, { "Retry-After": String(limit.retryAfterSec) });
    }

    const parsed = validateAward(ctx.body);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);

    const store = deps.getStore();
    if (!store) return json({ error: UNAVAILABLE }, 503);

    try {
      const out = await awardXp(store, ctx.sub, parsed.value);
      return json({ total: out.total, awarded: out.awarded }, 200);
    } catch (err) {
      if (err instanceof XpConflictError) return json({ error: err.message }, 409);
      logSafe("xp_post_error", { name: err instanceof Error ? err.name : "UnknownError" });
      return json({ error: UNAVAILABLE }, 503);
    }
  }

  return { handleGet, handlePost };
}
