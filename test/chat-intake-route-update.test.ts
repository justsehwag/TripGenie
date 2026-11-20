import { describe, expect, it } from "vitest";
import { initialIntakeState, step, type ChatEvent, type ChatIntakeState } from "@/lib/chat-intake";

function run(events: ChatEvent[], from: ChatIntakeState = initialIntakeState()) {
  let state = from;
  let last = { state, message: "", navigate: false };
  for (const e of events) {
    last = step(state, e);
    state = last.state;
  }
  return last;
}

const answered: ChatEvent[] = [
  { type: "text", text: "Delhi", extracted: { origin: "Delhi" } },
  { type: "text", text: "Goa", extracted: { destination: "Goa" } },
  { type: "text", text: "4 days", extracted: { durationDays: 4 } },
];

describe("route-only turns update an answered route", () => {
  it("applies both route fields when extraction sets routeOnly", () => {
    const r = run([
      ...answered,
      { type: "text", text: "Pune to Jaipur", extracted: { origin: "Pune", destination: "Jaipur" }, routeOnly: true },
    ]);
    expect(r.state.context.origin).toBe("Pune");
    expect(r.state.context.destination).toBe("Jaipur");
    expect(r.state.context.durationDays).toBe(4);
    expect(r.state.status.origin).toBe("answered");
    expect(r.navigate).toBe(false);
  });

  it("treats a turn with both origin and destination as route-only", () => {
    const r = run([
      ...answered,
      { type: "text", text: "Pune to Jaipur", extracted: { origin: "Pune", destination: "Jaipur" } },
    ]);
    expect(r.state.context.origin).toBe("Pune");
    expect(r.state.context.destination).toBe("Jaipur");
  });

  it("does not overwrite another answered field from the side", () => {
    const r = run([
      ...answered,
      { type: "text", text: "7 days", extracted: { durationDays: 7 } },
    ]);
    expect(r.state.context.durationDays).toBe(4);
  });

  it("does not overwrite an answered origin from a single-field non-route turn", () => {
    const r = run([
      ...answered,
      { type: "text", text: "Mumbai", extracted: { origin: "Mumbai" } },
    ]);
    expect(r.state.context.origin).toBe("Delhi");
  });

  it("ignores a non-string route value", () => {
    const r = run([
      ...answered,
      {
        type: "text",
        text: "x",
        extracted: { origin: 1, destination: "Jaipur" } as never,
        routeOnly: true,
      },
    ]);
    expect(r.state.context.origin).toBe("Delhi");
    expect(r.state.context.destination).toBe("Jaipur");
  });
});
