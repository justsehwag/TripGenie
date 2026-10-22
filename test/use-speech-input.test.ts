// Feature: realtime-ai-integration — browser Voice_Input (spec tasks 8.2 / 8.3).
//
// These tests cover the PURE / feature-detect + capture-contract logic of the
// `useSpeechInput` hook (lib/voice.ts-wrapped) WITHOUT a live DOM
// `SpeechRecognition`:
//
//   - `detectSpeechSupport` reports the supported vs unsupported branch from an
//     injected global (Req 9.1 / 9.2).
//   - A failing `CaptureAttempt` fed through `captureVoice` (via
//     `runCaptureAttempt`) yields an UNSUCCESSFUL `VoiceCaptureResult` whose
//     `preservedText` equals the caller's existing text and which carries NO
//     transcribed text — Property 9 (Req 9.3 / 9.5).
//
// 8.3 — MANUAL / INTEGRATION verification (NOT in the automated gate):
//   Real Web Speech microphone capture is exercised by hand, not here. Chrome
//   and Edge expose `window.SpeechRecognition` / `webkitSpeechRecognition` and
//   capture live audio; Safari and Firefox (no Web Speech API) must fall through
//   to the honest "voice unavailable" branch with the text input still usable.
//   Those live-browser paths depend on a real microphone + browser engine and
//   are verified manually/integration, outside this Node vitest suite. This gate
//   only asserts the DOM-free feature-detect and capture-contract logic.

import { describe, it, expect, vi } from "vitest";
import {
  detectSpeechSupport,
  resolveRecognitionCtor,
  runCaptureAttempt,
  BROWSER_VOICE_CAPABILITY,
} from "@/components/use-speech-input";
import { selectBackend, type CaptureAttempt } from "@/lib/voice";

/** A minimal stand-in for the Web Speech recognizer constructor. */
class FakeRecognition {
  lang = "";
  interimResults = false;
  continuous = false;
  maxAlternatives = 1;
  start() {}
  stop() {}
  abort() {}
  onresult = null;
  onerror = null;
  onend = null;
}

describe("Feature: realtime-ai-integration, useSpeechInput feature-detect", () => {
  it("reports supported when a standard SpeechRecognition constructor is present", () => {
    const win = { SpeechRecognition: FakeRecognition } as unknown as never;
    expect(detectSpeechSupport(win)).toBe(true);
    expect(resolveRecognitionCtor(win)).toBe(FakeRecognition as unknown);
  });

  it("reports supported via the webkit-prefixed constructor", () => {
    const win = { webkitSpeechRecognition: FakeRecognition } as unknown as never;
    expect(detectSpeechSupport(win)).toBe(true);
    expect(resolveRecognitionCtor(win)).toBe(FakeRecognition as unknown);
  });

  it("reports UNSUPPORTED when no recognizer constructor exists (fallback branch)", () => {
    const win = {} as unknown as never;
    expect(detectSpeechSupport(win)).toBe(false);
    expect(resolveRecognitionCtor(win)).toBeNull();
  });

  it("is SSR-safe: no window and no injected global ⇒ unsupported, no throw", () => {
    expect(detectSpeechSupport(undefined)).toBe(false);
    expect(resolveRecognitionCtor(undefined)).toBeNull();
  });
});

describe("Feature: realtime-ai-integration, useSpeechInput capture contract", () => {
  it("routes through the Voice_Service with the browser capability (transcribe-polly label)", () => {
    // The browser STT path has no Nova Sonic; the retained label is contract-only.
    expect(BROWSER_VOICE_CAPABILITY.novaSonicAvailable).toBe(false);
    expect(selectBackend(BROWSER_VOICE_CAPABILITY)).toBe("transcribe-polly");
  });

  it("a successful attempt yields an ok result carrying the recognized transcript", async () => {
    const result = await runCaptureAttempt("draft", async () => "fly to Goa");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("fly to Goa");
      expect(result.backend).toBe("transcribe-polly");
    }
  });

  // Feature: realtime-ai-integration, Property 9
  it("a failing CaptureAttempt preserves the existing draft and fabricates NO transcript (Property 9)", async () => {
    const existing = "my half-written trip idea";
    const failing: CaptureAttempt = vi.fn(async () => {
      throw new Error("mic blocked");
    });

    const result = await runCaptureAttempt(existing, failing);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Draft preserved verbatim (Req 9.3).
      expect(result.preservedText).toBe(existing);
      // Descriptive error naming the backend; no fabricated transcript (Req 9.5).
      expect(result.error).toContain("mic blocked");
      expect(result.error.toLowerCase()).toContain("transcribe-polly");
      // No `text` field is present on the error branch — nothing transcribed.
      expect((result as { text?: string }).text).toBeUndefined();
    }
    expect(failing).toHaveBeenCalledOnce();
  });

  it("an empty existing draft is preserved as empty on failure (still no fabrication)", async () => {
    const result = await runCaptureAttempt("", async () => {
      throw new Error("no speech detected");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.preservedText).toBe("");
      expect(result.error).toContain("no speech detected");
    }
  });
});
