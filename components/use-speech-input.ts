"use client";

/**
 * Browser Voice_Input via the Web Speech API — spec task 8.1
 * (Feature: realtime-ai-integration, Requirements 9.1-9.5).
 *
 * This hook wraps `window.SpeechRecognition` / `window.webkitSpeechRecognition`
 * HONESTLY:
 *
 *   - It feature-detects the API and exposes `supported`. When the browser has
 *     no Web Speech API the hook fabricates NO transcript; `start()` is a no-op
 *     that only flips the status to "unavailable" so the caller can keep showing
 *     the existing honest VOICE_UNAVAILABLE message and leave the text input
 *     usable (Req 9.2, 9.5).
 *   - When supported, `start()`/`stop()` drive a real `SpeechRecognition`
 *     instance. A final recognized transcript is pushed to the caller via the
 *     `onResult` callback and the returned `transcript` state (Req 9.1).
 *   - On `onerror`, or `onend` with no final result, the hook returns a
 *     descriptive error and PRESERVES the caller's existing draft unchanged —
 *     it never clears it and never invents text (Req 9.3, 9.5).
 *
 * The capture result is routed through `captureVoice` from `lib/voice.ts` so the
 * `VoiceCaptureResult` output shape is honored UNCHANGED (Req 9.4). Web Speech is
 * the browser speech-to-text engine; `lib/voice.ts` still selects a backend
 * LABEL of "transcribe-polly" (novaSonicAvailable:false). That label is retained
 * purely for contract-compatibility with the existing Voice_Service — it does not
 * mean an AWS Transcribe call is made from the browser path.
 *
 * All `window` access is SSR-guarded. The hook changes no visual structure — the
 * wiring into the concierge mic control is deferred to a later task.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  captureVoice,
  type CaptureAttempt,
  type VoiceCapability,
  type VoiceCaptureResult,
} from "@/lib/voice";

/* ---------------------------------------------------------------------------
 * Minimal structural typings for the Web Speech API. The DOM lib does not ship
 * `SpeechRecognition` types in every TS config, so we declare only what we use.
 * ------------------------------------------------------------------------- */

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { readonly transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  readonly error?: string;
  readonly message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Window shape with the (optionally prefixed) Web Speech constructor. */
interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

/* ---------------------------------------------------------------------------
 * Voice_Service contract wiring. The browser STT path has no Nova Sonic, so the
 * capability reports `novaSonicAvailable:false` and `selectBackend` resolves the
 * "transcribe-polly" label (see the module header note on why the label stays).
 * ------------------------------------------------------------------------- */

/** Capability for the browser Web Speech path (no Nova Sonic). */
export const BROWSER_VOICE_CAPABILITY: VoiceCapability = { novaSonicAvailable: false };

/* ---------------------------------------------------------------------------
 * Pure, DOM-free helpers (unit-testable without a browser).
 * ------------------------------------------------------------------------- */

/**
 * Feature-detect the Web Speech API against an injected global (defaults to the
 * ambient `window` when present). SSR-safe: returns `false` when there is no
 * window or no recognizer constructor. Fabricates nothing.
 */
export function detectSpeechSupport(win?: SpeechWindow | undefined): boolean {
  const w = win ?? (typeof window !== "undefined" ? (window as unknown as SpeechWindow) : undefined);
  if (!w) return false;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** Resolve the (possibly prefixed) recognizer constructor, or null when absent. */
export function resolveRecognitionCtor(
  win?: SpeechWindow | undefined,
): SpeechRecognitionCtor | null {
  const w = win ?? (typeof window !== "undefined" ? (window as unknown as SpeechWindow) : undefined);
  if (!w) return null;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Run a raw capture `attempt` through `captureVoice`, honoring the Voice_Service
 * `VoiceCaptureResult` shape unchanged. On success the result carries the
 * transcribed `text`; on failure it carries a descriptive `error` and the
 * caller's `existingText` as `preservedText` (never a fabricated transcript).
 *
 * Pure with respect to the DOM: the `attempt` is injected, so this is directly
 * unit-testable without a live `SpeechRecognition`.
 */
export function runCaptureAttempt(
  existingText: string,
  attempt: CaptureAttempt,
  capability: VoiceCapability = BROWSER_VOICE_CAPABILITY,
): Promise<VoiceCaptureResult> {
  return captureVoice(capability, existingText, attempt);
}

/* ---------------------------------------------------------------------------
 * Hook
 * ------------------------------------------------------------------------- */

export type SpeechInputStatus = "idle" | "listening" | "unavailable" | "error";

export interface UseSpeechInputOptions {
  /** The caller's current draft text, preserved verbatim on failure (Req 9.3). */
  existingText?: string;
  /** Recognition language tag; defaults to "en-US". */
  lang?: string;
  /** Surface interim (non-final) results to `onResult`; defaults to false. */
  interimResults?: boolean;
  /** Invoked with the final capture result once recognition settles. */
  onResult?: (result: VoiceCaptureResult) => void;
}

export interface UseSpeechInput {
  /** True when the browser exposes a Web Speech recognizer. */
  supported: boolean;
  /** Current lifecycle status of the recognizer. */
  status: SpeechInputStatus;
  /** Latest final transcript, or "" when none captured this session. */
  transcript: string;
  /** Latest descriptive error, or "" when none. */
  error: string;
  /** Begin listening. No-op (status → "unavailable") when unsupported. */
  start: () => void;
  /** Stop listening and release the active recognizer. */
  stop: () => void;
}

/**
 * React hook wrapping the Web Speech API honestly. See the module header for the
 * full contract. Guards all `window` access for SSR.
 */
export function useSpeechInput(options: UseSpeechInputOptions = {}): UseSpeechInput {
  const { lang = "en-US", interimResults = false, onResult } = options;

  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<SpeechInputStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");

  // Mutable refs avoid stale closures without re-subscribing listeners.
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const existingTextRef = useRef(options.existingText ?? "");
  const onResultRef = useRef(onResult);
  const gotFinalRef = useRef(false);

  // Keep refs current across renders (no listener churn).
  existingTextRef.current = options.existingText ?? "";
  onResultRef.current = onResult;

  // Feature-detect once mounted (client-only; SSR renders supported=false).
  useEffect(() => {
    setSupported(detectSpeechSupport());
  }, []);

  /** Settle a capture via the Voice_Service contract and notify the caller. */
  const settle = useCallback(async (attempt: CaptureAttempt) => {
    const result = await runCaptureAttempt(existingTextRef.current, attempt);
    if (result.ok) {
      setTranscript(result.text);
      setError("");
      setStatus("idle");
    } else {
      // Preserve the existing draft; fabricate no transcript (Req 9.3/9.5).
      setError(result.error);
      setStatus("error");
    }
    onResultRef.current?.(result);
  }, []);

  const releaseRecognition = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        // abort() can throw if already stopped; ignore.
      }
      recognitionRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    const Ctor = resolveRecognitionCtor();
    if (!Ctor) {
      // Unsupported: no transcript, caller keeps its honest fallback message.
      setSupported(false);
      setStatus("unavailable");
      return;
    }

    // Tear down any prior instance before starting a fresh capture.
    releaseRecognition();
    gotFinalRef.current = false;
    setError("");
    setStatus("listening");

    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = interimResults;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    recognitionRef.current = rec;

    rec.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const alt = res[0];
        if (!alt) continue;
        if (res.isFinal) finalText += alt.transcript;
        else interimText += alt.transcript;
      }

      if (interimResults && interimText && !finalText) {
        // Surface interim text for live display without settling the capture.
        setTranscript(interimText);
        return;
      }

      if (finalText) {
        gotFinalRef.current = true;
        const text = finalText.trim();
        void settle(async () => text);
      }
    };

    rec.onerror = (event) => {
      gotFinalRef.current = true; // onend must not also raise an error.
      const reason = event.error || event.message || "speech recognition error";
      releaseRecognition();
      void settle(async () => {
        throw new Error(reason);
      });
    };

    rec.onend = () => {
      // Ended with no final result → honest failure that preserves the draft.
      if (!gotFinalRef.current) {
        gotFinalRef.current = true;
        releaseRecognition();
        void settle(async () => {
          throw new Error("no speech detected");
        });
      }
    };

    try {
      rec.start();
    } catch (err) {
      gotFinalRef.current = true;
      releaseRecognition();
      const reason = err instanceof Error ? err.message : "could not start recognition";
      void settle(async () => {
        throw new Error(reason);
      });
    }
  }, [interimResults, lang, releaseRecognition, settle]);

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // stop() can throw if not started; fall back to a hard release.
        releaseRecognition();
      }
    }
    if (status === "listening") setStatus("idle");
  }, [releaseRecognition, status]);

  // Clean up listeners/instance on unmount.
  useEffect(() => releaseRecognition, [releaseRecognition]);

  return { supported, status, transcript, error, start, stop };
}
