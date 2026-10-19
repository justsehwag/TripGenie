import { describe, it, expect } from "vitest";
import { captureVoice, selectBackend } from "@/lib/voice";

/** Feature: tripgenie - voice backend selection and error preservation (Req 3.3-3.5). */

describe("Feature: tripgenie, voice", () => {
  it("selects Nova Sonic when available, else Transcribe+Polly (Req 3.3/3.4)", () => {
    expect(selectBackend({ novaSonicAvailable: true })).toBe("nova-sonic");
    expect(selectBackend({ novaSonicAvailable: false })).toBe("transcribe-polly");
  });

  it("returns transcribed text on success", async () => {
    const r = await captureVoice({ novaSonicAvailable: true }, "old", async () => "hello Goa");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("hello Goa");
      expect(r.backend).toBe("nova-sonic");
    }
  });

  it("on capture failure returns a descriptive error and preserves existing text (Req 3.5)", async () => {
    const r = await captureVoice({ novaSonicAvailable: false }, "my draft text", async () => { throw new Error("mic blocked"); });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("mic blocked");
      expect(r.error.toLowerCase()).toContain("transcribe-polly");
      expect(r.preservedText).toBe("my draft text");
    }
  });
});
