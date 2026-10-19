/**
 * Voice session route — thin App Router handler over `lib/voice.ts`.
 *
 * Brokers speech-to-text / text-to-speech through the Voice Service:
 * Nova Sonic when available, else Transcribe (STT) + Polly (TTS)
 * (design: Voice Service — Req 3.1/3.2/3.3/3.4). On capture failure it
 * returns a descriptive error while preserving the traveler's existing
 * text input (Req 3.5).
 *
 * Server-side only; no secrets are read or returned here. Supplier/voice
 * credentials would be resolved from AWS Secrets Manager at runtime (Req 17.3).
 *
 * Requirements: 3.1, 3.2, 3.5.
 */

import {
  captureVoice,
  selectBackend,
  type CaptureAttempt,
  type VoiceCapability,
} from "@/lib/voice";

export const runtime = "nodejs";

/**
 * Voice capability flag.
 *
 * No AWS voice backend (Nova Sonic / Transcribe / Polly) is wired in this
 * build — there are no voice credentials configured — so Nova Sonic is
 * reported unavailable by default. The flag is read from the environment so a
 * real deployment can flip it on once credentials exist, without code changes.
 * When unavailable, `selectBackend` yields the Transcribe+Polly fallback.
 */
function readCapability(): VoiceCapability {
  return {
    novaSonicAvailable: process.env.TRIPGENIE_NOVA_SONIC_AVAILABLE === "true",
  };
}

/**
 * Raw capture attempt. Because no real Nova Sonic / Transcribe backend is
 * configured, every attempt fails — which `captureVoice` turns into a
 * descriptive error that preserves the existing text (Req 3.5). Do NOT invent
 * AWS voice credentials here; a real adapter replaces this attempt in
 * deployment.
 */
const unconfiguredAttempt: CaptureAttempt = async (backend) => {
  throw new Error(`no ${backend} voice backend configured`);
};

/** GET /api/voice — report the selected backend for the current capability. */
export async function GET() {
  const capability = readCapability();
  const backend = selectBackend(capability);
  return Response.json({ backend, novaSonicAvailable: capability.novaSonicAvailable });
}

/**
 * POST /api/voice — attempt a voice capture.
 *
 * Body: `{ existingText?: string }`. Since no voice backend is configured the
 * capture fails and the response carries `ok: false`, a descriptive `error`,
 * and `preservedText === existingText` (Req 3.5).
 */
export async function POST(request: Request) {
  const capability = readCapability();

  let existingText = "";
  try {
    const body = await request.json();
    if (body && typeof body.existingText === "string") {
      existingText = body.existingText;
    }
  } catch {
    // Missing or malformed body: treat existing text as empty and still honor
    // the capture contract below.
  }

  const result = await captureVoice(capability, existingText, unconfiguredAttempt);

  if (result.ok) {
    return Response.json(result);
  }

  // Capture failed: preserve the traveler's text and surface the descriptive
  // error (Req 3.5). 503 — the voice backend is not available in this build.
  return Response.json(result, { status: 503 });
}
