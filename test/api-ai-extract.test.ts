import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelPrompt } from "@/lib/bedrock-model";

/**
 * `extract` action of /api/ai (chat-images-bedrock-planner task 2.14).
 * Only the Bedrock boundary is replaced; the real route, extraction and
 * grounding run against an injected fake `invokeModel`. No network.
 */

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

function post(body: unknown): Request {
  return new Request("http://localhost/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function extract(body: Record<string, unknown>) {
  const res = await POST(post({ action: "extract", ...body }));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  fakeInvoke = async () => "";
});

describe("/api/ai action=extract", () => {
  it("drops a field the traveller's text does not support", async () => {
    fakeInvoke = async () =>
      JSON.stringify({ destination: "Paris", budgetLevel: "luxury", pace: "packed" });
    const { status, json } = await extract({ text: "I want to visit Paris" });
    expect(status).toBe(200);
    expect(json.source).toBe("bedrock");
    expect(json.fields.destination).toBe("Paris");
    expect(json.fields.budgetLevel).toBeUndefined();
    expect(json.fields.pace).toBeUndefined();
  });

  it("keeps a field the text does support", async () => {
    fakeInvoke = async () => JSON.stringify({ destination: "Paris", budgetLevel: "luxury" });
    const { json } = await extract({ text: "Luxury trip to Paris" });
    expect(json.fields.budgetLevel).toBe("luxury");
    expect(json.fields.destination).toBe("Paris");
  });

  it("route-only turn keeps only origin and destination", async () => {
    fakeInvoke = async () =>
      JSON.stringify({
        origin: "Delhi",
        destination: "Goa",
        diet: "From Delhi to Goa",
        pace: "relaxed",
        durationDays: 5,
      });
    const { json } = await extract({ text: "From Delhi to Goa", asked: "diet" });
    expect(json.routeOnly).toBe(true);
    expect(Object.keys(json.fields).sort()).toEqual(["destination", "origin"]);
    expect(json.fields.origin).toBe("Delhi");
    expect(json.fields.destination).toBe("Goa");
  });

  it("with the model unreachable, the offline fallback gives the same route-only result", async () => {
    fakeInvoke = async () => {
      throw new Error("bedrock unreachable");
    };
    const { status, json } = await extract({ text: "From Delhi to Goa", asked: "diet" });
    expect(status).toBe(200);
    expect(json.routeOnly).toBe(true);
    expect(Object.keys(json.fields).sort()).toEqual(["destination", "origin"]);
    expect(json.fields.diet).toBeUndefined();
  });

  it("model returning nothing falls back and reports source=fallback", async () => {
    fakeInvoke = async () => "";
    const { json } = await extract({ text: "From Delhi to Goa", asked: "diet" });
    expect(json.source).toBe("fallback");
    expect(json.fields.diet).toBeUndefined();
    expect(json.fields.origin).toBe("Delhi");
    expect(json.fields.destination).toBe("Goa");
  });

  it("route text is never accepted as a diet answer", async () => {
    fakeInvoke = async () => JSON.stringify({ diet: "From Delhi to Goa" });
    const { json } = await extract({ text: "From Delhi to Goa", asked: "diet" });
    expect(json.fields.diet).toBeUndefined();
  });

  it("a genuine diet answer is kept for the asked field", async () => {
    fakeInvoke = async () => "";
    const { json } = await extract({ text: "vegetarian", asked: "diet" });
    expect(json.fields.diet).toBe("vegetarian");
    expect(json.routeOnly).toBe(false);
  });

  it("rejects a missing text with 400 and ignores an unknown asked field", async () => {
    const bad = await extract({});
    expect(bad.status).toBe(400);
    const ok = await extract({ text: "vegetarian", asked: "bogus" });
    expect(ok.status).toBe(200);
  });
});
