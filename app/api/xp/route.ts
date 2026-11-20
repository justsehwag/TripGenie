/**
 * XP API (xp-account-sync). Owner is the verified session `sub`.
 *
 * - GET  -> { total, awarded }
 * - POST -> body { event, idempotencyKey } (other fields ignored) -> { total, awarded }
 *           400 invalid, 409 conflict, 429 rate limited, 503 storage unavailable.
 */
import { withSession } from "@/lib/auth/with-session";
import { getAccountStore } from "@/lib/account/store";
import { createLimiter } from "@/lib/assistant/rate-limit";
import { createXpHandlers } from "@/lib/account/xp-route-handler";

export const dynamic = "force-dynamic";

const handlers = createXpHandlers({
  getStore: () => getAccountStore(),
  limiter: createLimiter({ max: 30, windowMs: 60_000 }),
});

export const GET = withSession(handlers.handleGet);
export const POST = withSession(handlers.handlePost, { maxBodyBytes: 2 * 1024 });
