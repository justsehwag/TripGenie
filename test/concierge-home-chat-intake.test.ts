// Static source checks for the chat wiring in components/concierge-home.tsx (task 2.6).
// The component needs router and trip-context providers, so it is checked as source text.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "..", "components", "concierge-home.tsx"), "utf8").replace(/\r\n/g, "\n");
const chatPanel = src.slice(src.indexOf("export default function ConciergeHome"));

describe("concierge-home chat wiring", () => {
  it("drives the chat with lib/chat-intake instead of the preference controller", () => {
    expect(src).toContain('from "@/lib/chat-intake"');
    expect(src).not.toMatch(/\badvance\(/);
    expect(src).not.toContain("uncollected");
    expect(src).not.toContain("ControllerState");
    expect(src).not.toContain('action: "turn"');
  });

  it("calls the extract action once per turn with a grounded local fallback", () => {
    expect(src).toContain('action: "extract"');
    expect(src).toContain("fallbackExtractForField(answer, {}, asked)");
    expect(src).toContain("groundExtraction({ text: answer, asked, extracted: fb })");
    expect(src).toContain('type: "text", text: answer, extracted: fields');
  });

  it("seeds persisted context through the seed event so values are carried", () => {
    expect(src).toContain('{ type: "seed", context: ctx }');
    expect(src).toContain('{ type: "seed", context: plan.context }');
  });

  it("has no automatic redirect and no timed navigation", () => {
    expect(src).not.toContain("redirectIfComplete");
    expect(src).not.toMatch(/setTimeout\([^)]*\/trip/);
    expect(src).not.toMatch(/setTimeout\([^)]*router\.push/);
  });

  it("navigates to /trip from exactly one place, the generate handler", () => {
    const pushes = chatPanel.match(/router\.push\("\/trip"\)/g) ?? [];
    expect(pushes).toHaveLength(1);
    const gen = chatPanel.slice(chatPanel.indexOf("function generateItinerary"));
    const body = gen.slice(0, gen.indexOf("\n  }\n"));
    expect(body).toContain('{ type: "generate" }');
    expect(body).toContain("if (!r.navigate)");
    expect(body.indexOf("sharedContext.setContext(intake.context)")).toBeLessThan(body.indexOf('router.push("/trip")'));
  });

  it("renders ChatSummaryCard only in the summary phase and wires Generate to the handler", () => {
    expect(src).toContain('import ChatSummaryCard from "@/components/chat-summary-card"');
    expect(src).toMatch(/\{inSummary && \(\s*<ChatSummaryCard/);
    expect(src).toContain("onGenerate={generateItinerary}");
    expect(src).toContain("onEdit={editField}");
  });

  it("chips only submit a turn and never navigate", () => {
    expect(src).toContain("onClick={() => submit(prompt)}");
    expect(src).toContain("chat-chip");
    const chipStart = src.indexOf("activeSuggestions.map((prompt)");
    const chipEnd = src.indexOf("</button>", chipStart);
    expect(src.slice(chipStart, chipEnd)).not.toContain("router.push");
  });

  it("offers Skip only for skippable fields and reset dispatches the reset event", () => {
    expect(src).toContain("SKIPPABLE.includes(intake.asked)");
    expect(src).toContain('intakeStep(intake, { type: "reset" })');
    expect(src).toContain("sharedContext.reset()");
  });

  it("no longer writes partial context to the shared provider inside submit", () => {
    const submitStart = src.indexOf("async function submit(");
    const submitEnd = src.indexOf("function applyIntakeEvent");
    expect(src.slice(submitStart, submitEnd)).not.toContain("sharedContext.setContext");
  });

  it("keeps the quick-form path untouched", () => {
    expect(src).not.toContain("quick-form");
  });

  it("has no bare LF (CRLF preserved)", () => {
    const raw = readFileSync(join(__dirname, "..", "components", "concierge-home.tsx"));
    let bare = 0;
    for (let i = 0; i < raw.length; i++) if (raw[i] === 10 && (i === 0 || raw[i - 1] !== 13)) bare++;
    expect(bare).toBe(0);
  });
});
