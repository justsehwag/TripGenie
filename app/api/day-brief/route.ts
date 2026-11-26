import { NextResponse } from "next/server";
import { createBedrockInvoke } from "@/lib/bedrock-model";
import {
  buildBriefPrompt,
  fallbackBrief,
  isEmptyBrief,
  parseBrief,
  type BriefFacts,
  type BriefSource,
  type DayBrief,
} from "@/lib/know-more/brief";

export const dynamic = "force-dynamic";

const MAX_PLACES = 12;
const MAX_FIELD = 400;
const MAX_TIME = 40;
const OUTER_GUARD_MS = 14_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown, max: number, required: boolean): string | null {
  if (v === undefined || v === null) return required ? null : "";
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (required && t.length === 0) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function numOrNull(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v;
}

/** Validate and bound the body. Returns null when invalid. */
function parseFacts(body: unknown): BriefFacts | null {
  if (!isRecord(body)) return null;
  const destination = text(body.destination, MAX_FIELD, true);
  if (destination === null) return null;
  const day = body.day;
  if (typeof day !== "number" || !Number.isFinite(day) || day < 1 || day > 365) return null;
  const rawPlaces = body.places;
  if (!Array.isArray(rawPlaces) || rawPlaces.length === 0 || rawPlaces.length > MAX_PLACES) {
    return null;
  }
  const places: BriefFacts["places"] = [];
  for (const raw of rawPlaces) {
    if (!isRecord(raw)) return null;
    const title = text(raw.title, MAX_FIELD, true);
    const time = text(raw.time, MAX_TIME, false);
    const description = text(raw.description, MAX_FIELD, false);
    const excerptRaw = raw.reviewExcerpt;
    const reviewExcerpt =
      excerptRaw === undefined || excerptRaw === null ? null : text(excerptRaw, MAX_FIELD, false);
    const rating = numOrNull(raw.rating);
    const ratingCount = numOrNull(raw.ratingCount);
    if (
      title === null ||
      time === null ||
      description === null ||
      (excerptRaw !== undefined && excerptRaw !== null && reviewExcerpt === null) ||
      rating === undefined ||
      ratingCount === undefined
    ) {
      return null;
    }
    places.push({
      title,
      time,
      description,
      rating,
      ratingCount,
      reviewExcerpt: reviewExcerpt === "" ? null : reviewExcerpt,
    });
  }
  return { destination, day: Math.trunc(day), places };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const facts = parseFacts(body);
  if (!facts) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const invoke = createBedrockInvoke();
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("day brief timed out")), OUTER_GUARD_MS);
    });
    const raw = await Promise.race<string>([invoke(buildBriefPrompt(facts)), guard]);
    const brief: DayBrief = parseBrief(raw, facts);
    if (!isEmptyBrief(brief)) {
      const source: BriefSource = "ai";
      return NextResponse.json({ brief, source });
    }
  } catch (err) {
    // Log the error class only; never the prompt or the model answer.
    console.warn("day-brief model call failed:", err instanceof Error ? err.name : "unknown");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const source: BriefSource = "itinerary";
  return NextResponse.json({ brief: fallbackBrief(facts), source });
}
