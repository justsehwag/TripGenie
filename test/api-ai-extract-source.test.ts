import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ModelPrompt } from "@/lib/bedrock-model";

let fakeInvoke: (prompt: ModelPrompt) => Promise<string>;

vi.mock("@/lib/bedrock-model", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bedrock-model")>(
    "@/lib/bedrock-model",
  );
  return {
    ...actual,
    createBedrockInvoke: () => (prompt: ModelPrompt) => fakeInvoke(prompt),
  };
});

import { POST } from "@/app/api/ai/route";

async function extract(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://localhost/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "extract", ...body }),
    }),
  );
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  fakeInvoke = async () => "";
});

describe("/api/ai extract source", () => {
  it("reports fallback when the model throws, even if fallback finds a field", async () => {
    fakeInvoke = async () => {
      throw new Error("model down");
    };
    const { status, json } = await extract({ text: "Delhi to Goa", asked: "origin" });
    expect(status).toBe(200);
    expect(json.source).toBe("fallback");
    expect(json.fields.destination).toBe("Goa");
  });

  it("reports bedrock when the model answers", async () => {
    fakeInvoke = async () => JSON.stringify({ destination: "Paris" });
    const { json } = await extract({ text: "I want to visit Paris" });
    expect(json.source).toBe("bedrock");
  });
});
