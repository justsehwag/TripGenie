// Feature: footer-session-state. The footer account link follows the live session.
// Validates: Requirements 1.1, 1.3, 1.4, 1.5, 2.1, 2.3.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import SiteFooter from "@/components/site-footer";
import {
  accountLabel,
  followAccountSession,
} from "@/components/site-footer-account";
import type { IdentityProviderPolicy } from "@/lib/identity";

const mocks = vi.hoisted(() => ({
  fetchSession: vi.fn(),
  subscribeSession: vi.fn(),
}));

vi.mock("@/lib/client/account-session", () => mocks);

const POLICY: IdentityProviderPolicy = { enabledProviders: ["email", "google"] };

function renderFooter(session: { userId: string; firstName?: string } | null) {
  return renderToStaticMarkup(
    React.createElement(SiteFooter, { providerPolicy: POLICY, session }),
  );
}

describe("footer session state", () => {
  let subscriber: ((s: unknown) => void) | undefined;
  const unsub = vi.fn();

  beforeEach(() => {
    subscriber = undefined;
    unsub.mockReset();
    mocks.fetchSession.mockReset();
    mocks.fetchSession.mockResolvedValue({ signedIn: false, user: null });
    mocks.subscribeSession.mockReset();
    mocks.subscribeSession.mockImplementation((cb: (s: unknown) => void) => {
      subscriber = cb;
      return unsub;
    });
  });

  it("renders Sign in for an anonymous session", () => {
    expect(renderFooter(null)).toContain("Sign in");
  });

  it("renders the manage label for a named session", () => {
    const html = renderFooter({ userId: "u1", firstName: "Asha" });
    expect(html).toContain("Manage Asha&#x27;s account");
    expect(html).not.toContain("Sign in");
  });

  it("labels sessions without a first name", () => {
    expect(accountLabel({ userId: "u1" })).toBe("Manage your account");
    expect(accountLabel(null)).toBe("Sign in");
    expect(accountLabel({ userId: "u1", firstName: "Asha" })).toBe(
      "Manage Asha's account",
    );
  });

  it("follows sign-in and sign-out from subscribeSession", () => {
    const onChange = vi.fn();
    followAccountSession(onChange);
    subscriber!({ signedIn: true, user: { email: "a@b.c", name: "Asha" } });
    const session = onChange.mock.calls[0][0];
    expect(session.firstName).toBe("Asha");
    expect(accountLabel(session)).toBe("Manage Asha's account");
    subscriber!({ signedIn: false, user: null });
    expect(onChange.mock.calls[1][0]).toBeNull();
  });

  it("applies the hydrated session from fetchSession", async () => {
    mocks.fetchSession.mockResolvedValue({
      signedIn: true,
      user: { email: "a@b.c", name: "Asha" },
    });
    const onChange = vi.fn();
    followAccountSession(onChange);
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].firstName).toBe("Asha");
  });

  it("ignores a fetchSession error and unsubscribes on cleanup", async () => {
    mocks.fetchSession.mockResolvedValue({
      signedIn: false,
      user: null,
      error: "boom",
    });
    const onChange = vi.fn();
    const cleanup = followAccountSession(onChange);
    await new Promise((r) => setTimeout(r, 0));
    expect(onChange).not.toHaveBeenCalled();
    cleanup();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("keeps SiteFooter a server component and the account link a client one", () => {
    const root = join(__dirname, "..", "components");
    const account = readFileSync(join(root, "site-footer-account.tsx"), "utf8");
    const footer = readFileSync(join(root, "site-footer.tsx"), "utf8");
    expect(account.trimStart().startsWith('"use client"')).toBe(true);
    expect(account).toContain("fetchSession");
    expect(account).toContain("subscribeSession");
    expect(footer).not.toMatch(/^\s*["']use client["']/m);
  });
});
