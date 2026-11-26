/**
 * Feature: knowmore-welcome-look - welcome markup uses the scenic backdrop.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/client/account-session", () => ({
  fetchSession: async () => ({ signedIn: false }),
  notifySession: () => {},
}));
vi.mock("@/components/destination-image", () => ({
  useDestinationImage: () => ({ url: null, loading: false, status: "idle" }),
}));

import AuthLanding from "@/components/auth-landing";

describe("AuthLanding scenic backdrop", () => {
  it("renders the landscape hero, scenic class and guest button", () => {
    const html = renderToStaticMarkup(
      createElement(AuthLanding, { policy: { enabledProviders: ["email", "google"] } } as never),
    );
    expect(html).toContain("account-cine");
    expect(html).toContain("auth-split--scenic");
    expect(html).toContain("Continue without signing in");
    expect(html).toContain("Plan smarter. Travel better.");
  });
});
