import { describe, it, expect } from "vitest";
import { isAllowedOrigin, normalizeOrigin } from "@/lib/auth/origin";

const APP = "https://app.example.com";
const allowed = [APP];

function h(rec: Record<string, string>): Headers {
  return new Headers(rec);
}

describe("isAllowedOrigin", () => {
  it("accepts a matching Origin on POST", () => {
    expect(isAllowedOrigin("POST", h({ origin: APP }), allowed)).toBe(true);
  });

  it("rejects a foreign Origin", () => {
    expect(isAllowedOrigin("POST", h({ origin: "https://evil.example" }), allowed)).toBe(false);
  });

  it("rejects the null Origin, even with same-origin fetch metadata", () => {
    expect(isAllowedOrigin("POST", h({ origin: "null", "sec-fetch-site": "same-origin" }), allowed)).toBe(false);
  });

  it("handles an absent Origin by Sec-Fetch-Site", () => {
    expect(isAllowedOrigin("POST", h({ "sec-fetch-site": "same-origin" }), allowed)).toBe(true);
    expect(isAllowedOrigin("POST", h({ "sec-fetch-site": "cross-site" }), allowed)).toBe(false);
    expect(isAllowedOrigin("POST", h({}), allowed)).toBe(false);
  });

  it("supports multiple allowed origins", () => {
    const list = [APP, "http://localhost:3000"];
    expect(isAllowedOrigin("POST", h({ origin: "http://localhost:3000" }), list)).toBe(true);
    expect(isAllowedOrigin("POST", h({ origin: APP }), list)).toBe(true);
    expect(isAllowedOrigin("POST", h({ origin: "http://localhost:3001" }), list)).toBe(false);
  });

  it("fails closed with no allowed origins", () => {
    expect(isAllowedOrigin("POST", h({ origin: APP }), [])).toBe(false);
    expect(isAllowedOrigin("POST", h({ origin: APP }), undefined)).toBe(false);
  });

  it("normalises trailing slash and case", () => {
    expect(isAllowedOrigin("POST", h({ origin: "HTTPS://APP.Example.com/" }), allowed)).toBe(true);
    expect(isAllowedOrigin("POST", h({ origin: APP }), ["https://App.Example.com/"])).toBe(true);
    expect(normalizeOrigin("https://app.example.com/")).toBe(APP);
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
  });

  it("lets GET and HEAD pass regardless of headers", () => {
    expect(isAllowedOrigin("GET", h({ origin: "https://evil.example" }), allowed)).toBe(true);
    expect(isAllowedOrigin("HEAD", h({}), [])).toBe(true);
    expect(isAllowedOrigin("get", {}, allowed)).toBe(true);
  });

  it.each(["PUT", "DELETE", "PATCH"])("treats %s like POST", (method) => {
    expect(isAllowedOrigin(method, h({ origin: APP }), allowed)).toBe(true);
    expect(isAllowedOrigin(method, h({ origin: "https://evil.example" }), allowed)).toBe(false);
    expect(isAllowedOrigin(method, h({}), allowed)).toBe(false);
    expect(isAllowedOrigin(method, h({ "sec-fetch-site": "same-origin" }), allowed)).toBe(true);
  });

  it("fails OPTIONS and other methods", () => {
    expect(isAllowedOrigin("OPTIONS", h({ origin: APP }), allowed)).toBe(false);
    expect(isAllowedOrigin("TRACE", h({ origin: APP }), allowed)).toBe(false);
  });

  it("ignores the Host header", () => {
    expect(isAllowedOrigin("POST", h({ origin: "https://evil.example", host: "app.example.com" }), allowed)).toBe(false);
    expect(isAllowedOrigin("POST", { host: "app.example.com" }, allowed)).toBe(false);
  });

  it("works with a plain record, case-insensitively", () => {
    expect(isAllowedOrigin("POST", { Origin: APP }, allowed)).toBe(true);
    expect(isAllowedOrigin("POST", { origin: "https://evil.example" }, allowed)).toBe(false);
    expect(isAllowedOrigin("POST", { "Sec-Fetch-Site": "same-origin" }, allowed)).toBe(true);
    expect(isAllowedOrigin("POST", { origin: [APP] }, allowed)).toBe(true);
    expect(isAllowedOrigin("POST", { origin: undefined }, allowed)).toBe(false);
  });

  it("never throws on bad input", () => {
    expect(isAllowedOrigin("POST", null, allowed)).toBe(false);
    expect(isAllowedOrigin("POST", undefined, allowed)).toBe(false);
  });
});
