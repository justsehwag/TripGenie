/**
 * Request handler for POST /api/site-assistant. Lives here (not in the route
 * file) because Next.js route modules may only export HTTP methods and route
 * config. Server only.
 *
 * Never logs message text, history, context, itinerary or URLs: the only log
 * line carries status, model calls, tool calls and elapsed ms.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.5, 13.6, 13.7
 */
import { createConverseClient, type ConverseFn } from "@/lib/assistant/bedrock-tools";
import { clientKey, createLimiter, type Limiter } from "@/lib/assistant/rate-limit";
import type { ChatTurn } from "@/lib/assistant/types";
import { contentLengthOk, withinByteLimit } from "@/lib/assistant/wire";
import { runSiteLoop, type SiteLoopDeps, type SiteLoopInput, type SiteLoopOutput } from "./loop";
import { sanitizeContext } from "./sanitize";
import { PAGE_IDS, type PageId, type SiteAssistantResponse, type WireContext } from "./types";

export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_BODY_BYTES = 32_768;
export const MAX_MESSAGE_CHARS = 1000;
export const MAX_HISTORY_TURNS = 10;
export const MAX_HISTORY_TURN_CHARS = 1000;

export const KNOWN_PAGES: readonly PageId[] = PAGE_IDS;

/** Fixed, page-aware replies used when Bedrock fails or times out. */
export const FALLBACK_REPLIES: Readonly<Record<PageId, string>> = {
  discover:
    "The assistant is temporarily unavailable. You can keep browsing places on Discover and try again in a moment.",
  flights:
    "The assistant is temporarily unavailable. You can still search and compare flights yourself, and try again in a moment.",
  stays:
    "The assistant is temporarily unavailable. You can still search and compare stays yourself, and try again in a moment.",
  cars:
    "The assistant is temporarily unavailable. You can still search and compare cars yourself, and try again in a moment.",
  trips:
    "The assistant is temporarily unavailable. Your saved trips are unaffected. Please try again in a moment.",
  account:
    "The assistant is temporarily unavailable. You can still update your account settings yourself, and try again in a moment.",
  itinerary:
    "The assistant is temporarily unavailable. Your itinerary is unchanged, and you can edit it yourself or try again in a moment.",
  deals:
    "The assistant is temporarily unavailable. You can still browse deals yourself, and try again in a moment.",
  general: "The assistant is temporarily unavailable. Please try again in a moment.",
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface SiteAssistantHandlerDeps {
  limiter?: Limiter;
  /** Builds the Converse client; called once per request that passes validation. */
  converse?: ConverseFn;
  runLoop?: (deps: SiteLoopDeps, input: SiteLoopInput) => Promise<SiteLoopOutput>;
  log?: (line: string) => void;
}

function json(body: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE, ...(extra ?? {}) },
  });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPageId(v: unknown): v is PageId {
  return typeof v === "string" && (KNOWN_PAGES as readonly string[]).includes(v);
}

interface ParsedRequest {
  message: string;
  page: PageId;
  history: ChatTurn[];
  context: WireContext;
}

type ParseResult = { ok: true; value: ParsedRequest } | { ok: false; error: string };

function parseHistory(raw: unknown): ChatTurn[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const turns: ChatTurn[] = [];
  for (const t of raw) {
    if (!isObj(t) || (t.role !== "user" && t.role !== "assistant") || typeof t.text !== "string") continue;
    if (t.text.trim().length === 0) continue;
    turns.push({ role: t.role, text: t.text.slice(0, MAX_HISTORY_TURN_CHARS) });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

function parseBody(text: string): ParseResult {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (!isObj(body)) return { ok: false, error: "body must be an object" };
  if (!isPageId(body.page)) return { ok: false, error: "unknown page" };
  if (typeof body.message !== "string") return { ok: false, error: "message is required" };
  const message = body.message.trim();
  if (message.length < 1) return { ok: false, error: "message is empty" };
  if (message.length > MAX_MESSAGE_CHARS) return { ok: false, error: "message is too long" };
  const history = parseHistory(body.history);
  if (history === null) return { ok: false, error: "history is invalid" };

  let summary = "";
  let data: unknown = null;
  if (body.context !== undefined && body.context !== null) {
    if (!isObj(body.context)) return { ok: false, error: "context is invalid" };
    if (typeof body.context.summary === "string") summary = body.context.summary;
    data = body.context.data;
  }
  // Sanitize again server-side: the client copy is never trusted.
  const context = sanitizeContext(body.page, summary, data);
  return { ok: true, value: { message, page: body.page, history, context } };
}

export function createSiteAssistantHandler(
  deps: SiteAssistantHandlerDeps = {},
): (req: Request) => Promise<Response> {
  const limiter = deps.limiter ?? createLimiter({ max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });
  const runLoop = deps.runLoop ?? runSiteLoop;
  const log = deps.log ?? ((line: string) => console.info(line));

  function logLine(status: number, calls: number, tools: number, ms: number): void {
    try {
      log(`[site-assistant] status=${status} calls=${calls} tools=${tools} ms=${ms}`);
    } catch {
      /* logging must never break a request */
    }
  }

  return async function handle(req: Request): Promise<Response> {
    const started = Date.now();
    const done = (res: Response, calls = 0, tools = 0): Response => {
      logLine(res.status, calls, tools, Date.now() - started);
      return res;
    };
    try {
      const gate = limiter.allow(clientKey(req.headers));
      if (!gate.ok) {
        return done(
          json({ error: "Too many requests. Please wait a moment.", retryAfterSec: gate.retryAfterSec }, 429, {
            "Retry-After": String(gate.retryAfterSec),
          }),
        );
      }

      if (!contentLengthOk(req.headers.get("content-length"), MAX_BODY_BYTES)) {
        return done(json({ error: "Request too large." }, 413));
      }
      const text = await req.text();
      if (!withinByteLimit(text, MAX_BODY_BYTES)) {
        return done(json({ error: "Request too large." }, 413));
      }

      const parsed = parseBody(text);
      if (!parsed.ok) {
        return done(json({ error: parsed.error }, 400));
      }
      const { page } = parsed.value;

      const fallback = (): Response => {
        const body: SiteAssistantResponse = { reply: FALLBACK_REPLIES[page], proposals: [], status: "unavailable" };
        return json(body, 200);
      };

      let out: SiteLoopOutput;
      try {
        const converse = deps.converse ?? createConverseClient();
        out = await runLoop({ converse }, { ...parsed.value, signal: req.signal });
      } catch {
        return done(fallback());
      }

      if (out.status === "unavailable") return done(fallback(), out.calls, out.tools);

      const body: SiteAssistantResponse = { reply: out.reply, proposals: out.proposals, status: out.status };
      return done(json(body, 200), out.calls, out.tools);
    } catch {
      return done(json({ error: "Something went wrong." }, 500));
    }
  };
}
