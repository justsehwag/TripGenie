"use client";

/**
 * Footer account link that follows the live session, the same way
 * `GlobalNav` does. `SiteFooter` stays a server component and passes the
 * server-known session as `initialSession`; this client child renders it until
 * the live (cookie-verified) session resolves, then follows sign-in / sign-out.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { IdentitySession } from "@/lib/identity";
import { ACCOUNT_HREF } from "@/lib/nav-links";
import {
  fetchSession,
  subscribeSession,
  type SessionState,
} from "@/lib/client/account-session";

/** Map a client session state to an identity session (null when signed out). */
export function toSession(s: SessionState): IdentitySession | null {
  if (!s.signedIn || !s.user?.email) return null;
  // userId is display-only here (never sent to the server as an owner).
  return { userId: s.user.email, email: s.user.email, firstName: s.user.name };
}

/** Footer account link label for a session. */
export function accountLabel(
  session: IdentitySession | null | undefined,
): string {
  if (!session?.userId) return "Sign in";
  const first = session.firstName?.trim();
  return first ? `Manage ${first}'s account` : "Manage your account";
}

/**
 * Hydrate from the server and follow session changes in this tab. A
 * `fetchSession` error leaves the current state unchanged. Returns a cleanup.
 */
export function followAccountSession(
  onChange: (s: IdentitySession | null) => void,
): () => void {
  let alive = true;
  void fetchSession().then((s) => {
    if (alive && !s.error) onChange(toSession(s));
  });
  const unsub = subscribeSession((s) => onChange(toSession(s)));
  return () => {
    alive = false;
    unsub();
  };
}

export default function SiteFooterAccount({
  initialSession = null,
}: {
  initialSession?: IdentitySession | null;
}) {
  // undefined = live session not resolved yet; server and first client render
  // use initialSession, so hydration matches.
  const [live, setLive] = useState<IdentitySession | null | undefined>(
    undefined,
  );
  useEffect(() => followAccountSession(setLive), []);
  const active = live === undefined ? initialSession : live;

  return (
    <Link href={ACCOUNT_HREF} className="site-footer__account">
      {accountLabel(active)}
    </Link>
  );
}
