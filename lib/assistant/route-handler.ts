/**
 * Request handler for POST /api/assistant. Lives here (not in the route file)
 * because Next.js route modules may only export HTTP methods and route config.
 * Server only. Never logs message text, itinerary, profile values or URLs.
 */
import { createConverseClient, type ConverseFn } from "./bedrock-tools";
import { runAssistantLoop, type LoopDeps, type LoopInput, type LoopOutput } from "./loop";
import { clientKey, createLimiter, type Limiter } from "./rate-limit";
import { contentLengthOk, parseRequestText, withinByteLimit } from "./wire";

export const RATE_LIMIT_MAX = 20;
export const RATE_LIMIT_WINDOW_MS = 60_000;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export interface AssistantHandlerDeps {
  limiter?: Limiter;
  /** Builds the Converse client; called once per request that passes validation. */
  converse?: ConverseFn;
  runLoop?: (deps: LoopDeps, input: LoopInput) => Promise<LoopOutput>;
  log?: (line: string) => void;
}

function json(body: unknown, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...NO_STORE, ...(extra ?? {}) },
  });
}

export function createAssistantHandler(deps: AssistantHandlerDeps = {}): (req: Request) => Promise<Response> {
  const limiter = deps.limiter ?? createLimiter({ max: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });
  const runLoop = deps.runLoop ?? runAssistantLoop;
  const log =
    deps.log ?? ((line: string) => console.info(line));

  function logLine(status: number, calls: number, tools: number, ms: number): void {
    try {
      log(`[assistant] status=${status} calls=${calls} tools=${tools} ms=${ms}`);
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

      if (!contentLengthOk(req.headers.get("content-length"))) {
        return done(json({ error: "Request too large." }, 413));
      }
      const text = await req.text();
      if (!withinByteLimit(text)) {
        return done(json({ error: "Request too large." }, 413));
      }

      const parsed = parseRequestText(text);
      if (!parsed.ok) {
        return done(json({ error: parsed.error }, 400));
      }

      const converse = deps.converse ?? createConverseClient();
      const out = await runLoop({ converse }, { ...parsed.value, signal: req.signal });
      return done(json(out.response, 200), out.counters.modelCalls, out.counters.toolCalls);
    } catch {
      return done(json({ error: "Something went wrong." }, 500));
    }
  };
}
