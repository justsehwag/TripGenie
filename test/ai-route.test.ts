import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ModelPrompt } from "@/lib/bedrock-model";

/**
 * Realtime AI integration — Bedrock_Route tests (task 3.2).
 *
 * The model boundary is MOCKED: `createBedrockInvoke` is replaced so NO live
 * AWS call ever happens. The REAL route, controller, and model fallback logic
 * run against a controllable fake `invokeModel`. This also confirms Bedrock is
 * reached only server-side (the route imports `createBedrockInvoke`, never the
 * browser).
 */

// Controllable fake the mocked createBedrockInvoke hands back. Tests swap this
// per case. It receives the ModelPrompt so a test can branch on prompt content.
let fakeInvoke: (prompt: ModelPrompt) => Promise<string>;

vi.mock("@/lib/bedrock-model", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bedrock-model")>(
    "@/lib/bedrock-model",
  );
  return {
    ...actual,
    // Only the AWS boundary is stubbed; extract/phrase/itinerary stay real.
    createBedrockInvoke: () => (prompt: ModelPrompt) => fakeInvoke(prompt),
  };
});

// Import the route AFTER the mock is registered.
import { POST } from "@/app/api/ai/route";
import { uncollected } from "@/lib/preference-controller";

function post(body: unknown): Request {
  return new Request("http://localhost/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  // Default: a model that returns nothing interpretable.
  fakeInvoke = async () => "";
});

describe("Feature: realtime-ai-integration, Bedrock_Route /api/ai", () => {
  it("turn success: reflects extraction and asks for the next uncollected field", async () => {
    // The extraction prompt is the one carrying the "Latest input" marker; the
    // phrasing prompt carries "Missing field". Branch so extraction yields a
    // destination and phrasing yields a concrete question string.
    fakeInvoke = async (prompt) => {
      if (prompt.user.includes("Missing field")) {
        return "Which city are you flying out of for this trip?";
      }
      return JSON.stringify({ destination: "Tokyo" });
    };

    const res = await POST(
      post({
        action: "turn",
        state: { context: {}, questionsAsked: 0 },
        inputDelta: "I want to go to Tokyo",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    // Context reflects the extraction.
    expect(json.response.state.context.destination).toBe("Tokyo");
    expect(json.response.phase).toBe("collecting");

    // The next question targets the first uncollected field of the merged
    // context (origin comes before destination is filled → origin is next).
    const nextField = uncollected(json.response.state.context)[0];
    expect(nextField).toBe("origin");
    expect(json.response.prompt).toBe(
      "Which city are you flying out of for this trip?",
    );
  });

  it("turn with a throwing model still returns a valid ControllerResponse (no 500)", async () => {
    fakeInvoke = async () => {
      throw new Error("bedrock unavailable");
    };

    const res = await POST(
      post({
        action: "turn",
        state: { context: {}, questionsAsked: 0 },
        inputDelta: "a trip to Tokyo from Delhi",
      }),
    );
    // Never a 500 for a model failure.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.response).toBeDefined();
    expect(["collecting", "completion"]).toContain(json.response.phase);
    expect(typeof json.response.prompt).toBe("string");
    expect(typeof json.systemPromptPrefix).toBe("string");
  });

  it("turn with a hanging/timeout model still returns a valid ControllerResponse (no 500)", async () => {
    // Never resolves before the bounded timeout fires → treated as an error →
    // deterministic rule-based fallback kicks in.
    fakeInvoke = () => new Promise<string>(() => {});

    const res = await POST(
      post({
        action: "turn",
        state: { context: {}, questionsAsked: 0 },
        inputDelta: "Delhi to Tokyo for 5 days",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.response).toBeDefined();
    expect(["collecting", "completion"]).toContain(json.response.phase);
    expect(typeof json.response.prompt).toBe("string");
    // Rule-based fallback parses what it can from the delta; "5 days" resolves
    // a duration deterministically via the date-intake heuristics.
    expect(json.response.state.context.durationDays).toBe(5);
    // A turn makes up to two bounded model calls (extract then phrase), each
    // with a ~5s timeout, so a fully hanging model takes ~10s to degrade.
  }, 20000);

  it("itinerary with a failing model returns a valid fallback Itinerary", async () => {
    fakeInvoke = async () => {
      throw new Error("bedrock unavailable");
    };

    const res = await POST(
      post({
        action: "itinerary",
        context: { destination: "Tokyo", durationDays: 3 },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.itinerary).toBeDefined();
    expect(Array.isArray(json.itinerary.days)).toBe(true);
    expect(json.itinerary.days.length).toBeGreaterThanOrEqual(1);
    // The route reports a bedrock source even when the generator fell back
    // internally (the generator does not distinguish); a source is present.
    expect(typeof json.source).toBe("string");
  });

  it("bad JSON body returns 400", async () => {
    const res = await POST(post("{not valid json"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeDefined();
  });

  it("missing action returns 400", async () => {
    const res = await POST(post({ state: { context: {}, questionsAsked: 0 } }));
    expect(res.status).toBe(400);
  });

  it("unknown action returns 400", async () => {
    const res = await POST(post({ action: "frobnicate" }));
    expect(res.status).toBe(400);
  });

  it("turn with invalid controller state returns 400", async () => {
    const res = await POST(post({ action: "turn", inputDelta: "hi" }));
    expect(res.status).toBe(400);
  });

  it("itinerary with missing context returns 400", async () => {
    const res = await POST(post({ action: "itinerary" }));
    expect(res.status).toBe(400);
  });
});
