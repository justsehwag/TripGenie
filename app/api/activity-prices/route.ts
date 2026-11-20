import { NextResponse } from "next/server";
import { createBedrockInvoke } from "@/lib/bedrock-model";
import { fetchCurrency } from "@/lib/live-data";
import { searxngBaseUrl, webPricingEnabled } from "@/lib/config";
import { researchPricing } from "@/lib/web-pricing/service";
import {
  FX_TIMEOUT_MS,
  ROUTE_BUDGET_MS,
  USD_INR_FALLBACK,
  categoryEstimateInr,
  handlePriceRequest,
  validatePricerRequest,
  type PricerDeps,
} from "@/lib/activity-pricer";
import { validatePrices } from "@/lib/price-validator";
import { PriceCache } from "@/lib/price-cache";

/**
 * Batched INR activity pricing via Amazon Bedrock (one model call per
 * itinerary). Server-only: credentials, model id and prompt never reach the
 * response. Never returns 500.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Module-level cache, shared across requests on this server instance. */
const cache = new PriceCache();

/** Live USD to INR, bounded by FX_TIMEOUT_MS. A fallback-mode or bad rate gives USD_INR_FALLBACK. */
async function usdInr(): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const guard = new Promise<number>((resolve) => {
      timer = setTimeout(() => resolve(USD_INR_FALLBACK), FX_TIMEOUT_MS);
    });
    const live = fetchCurrency("USD", "INR").then((res) => {
      const rate = Number(res?.data?.rate);
      return res?.mode === "fallback" || !Number.isFinite(rate) || rate <= 0 ? USD_INR_FALLBACK : rate;
    });
    return await Promise.race([live, guard]);
  } catch {
    return USD_INR_FALLBACK;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400, headers: NO_STORE });
  }

  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deps: PricerDeps = { invoke: createBedrockInvoke(), cache, now: Date.now, usdInr };
    if (webPricingEnabled() && searxngBaseUrl() !== "") deps.research = researchPricing;

    // Route-level guard: if everything overruns, fall back to category estimates (200).
    const guard = new Promise<"timeout">((resolve) => {
      guardTimer = setTimeout(() => resolve("timeout"), ROUTE_BUDGET_MS);
    });
    const raced = await Promise.race([handlePriceRequest(body, deps), guard]);
    if (raced === "timeout") return categoryFallback(body);
    return NextResponse.json(raced.body, { status: raced.status, headers: NO_STORE });
  } catch {
    // Unexpected failure: a valid request still gets category estimates (200); otherwise 400.
    return categoryFallback(body);
  } finally {
    if (guardTimer !== undefined) clearTimeout(guardTimer);
  }
}

/** Category estimates (200) for a valid request; 400 for an invalid one. */
function categoryFallback(body: unknown): NextResponse {
  const parsed = validatePricerRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  }
  const { destination, activities } = parsed.value;
  const prices = validatePrices(undefined, activities, (a) =>
    categoryEstimateInr(a.kind, destination, USD_INR_FALLBACK),
  );
  return NextResponse.json({ prices, cached: false }, { status: 200, headers: NO_STORE });
}
