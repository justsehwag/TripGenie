import { describe, expect, it } from "vitest";
import { createLimiter, searxngLimiter } from "@/lib/grounding/limiter";

describe("grounding limiter", () => {
  it("acquires up to max, then returns null", () => {
    const l = createLimiter(3);
    const rel = [l.tryAcquire(), l.tryAcquire(), l.tryAcquire()];
    expect(rel.every((r) => typeof r === "function")).toBe(true);
    expect(l.inFlight()).toBe(3);
    expect(l.tryAcquire()).toBeNull();
    expect(l.inFlight()).toBe(3);
  });

  it("frees a slot on release and allows reacquire", () => {
    const l = createLimiter(1);
    const r = l.tryAcquire()!;
    expect(l.tryAcquire()).toBeNull();
    r();
    expect(l.inFlight()).toBe(0);
    expect(l.tryAcquire()).not.toBeNull();
  });

  it("release is idempotent and frees only one slot", () => {
    const l = createLimiter(2);
    const a = l.tryAcquire()!;
    l.tryAcquire();
    a();
    a();
    expect(l.inFlight()).toBe(1);
  });

  it("exports a shared limiter with max 5", () => {
    const held = Array.from({ length: 5 }, () => searxngLimiter.tryAcquire());
    expect(held.every(Boolean)).toBe(true);
    expect(searxngLimiter.tryAcquire()).toBeNull();
    held.forEach((r) => r!());
    expect(searxngLimiter.inFlight()).toBe(0);
  });
});
