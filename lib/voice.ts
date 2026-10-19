/**
 * Voice Service (backend selection core) - design section 4.
 * Nova Sonic when available, else Transcribe (STT) + Polly (TTS);
 * descriptive error on capture failure that preserves existing text input.
 * Requirements: 3.1-3.5.
 */

export type VoiceBackend = "nova-sonic" | "transcribe-polly";

export interface VoiceCapability { novaSonicAvailable: boolean }

/** Select the voice backend: Nova Sonic if available, else Transcribe+Polly (Req 3.3/3.4). */
export function selectBackend(cap: VoiceCapability): VoiceBackend {
  return cap.novaSonicAvailable ? "nova-sonic" : "transcribe-polly";
}

export interface VoiceCaptureOk { ok: true; text: string; backend: VoiceBackend }
export interface VoiceCaptureErr { ok: false; error: string; preservedText: string }
export type VoiceCaptureResult = VoiceCaptureOk | VoiceCaptureErr;

/** A raw capture attempt: resolves transcribed text or rejects on failure. */
export type CaptureAttempt = (backend: VoiceBackend) => Promise<string>;

/**
 * Capture speech as text. On failure, return a descriptive error and preserve
 * the traveler's existing text input unchanged (Req 3.5).
 */
export async function captureVoice(
  cap: VoiceCapability,
  existingText: string,
  attempt: CaptureAttempt,
): Promise<VoiceCaptureResult> {
  const backend = selectBackend(cap);
  try {
    const text = await attempt(backend);
    return { ok: true, text, backend };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return {
      ok: false,
      error: `Voice capture failed (${backend}): ${reason}`,
      preservedText: existingText,
    };
  }
}
