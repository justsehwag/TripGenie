"use client";

/**
 * Generic message for the `?auth_error=` query param set by the Google
 * sign-in redirects (account-sync, req 11.9 / 12). The raw value is never
 * rendered; only a fixed message for a known code is shown.
 */

import { useEffect, useState } from "react";

export const AUTH_ERROR_CODES = ["google_unavailable", "google_failed"] as const;

export function authErrorMessage(code: string | null | undefined): string {
  if (code === "google_unavailable") return "Google sign-in is not available right now. Please sign in with email.";
  if (code === "google_failed") return "Google sign-in did not complete. Please try again or sign in with email.";
  return "";
}

/** Reads `auth_error` from the current URL after mount (SSR-safe). */
export function useAuthErrorMessage(): string {
  const [message, setMessage] = useState("");
  useEffect(() => {
    try {
      const code = new URLSearchParams(window.location.search).get("auth_error");
      setMessage(authErrorMessage(code));
    } catch {
      setMessage("");
    }
  }, []);
  return message;
}

export default function AuthErrorNotice() {
  const message = useAuthErrorMessage();
  if (!message) return null;
  return (
    <p role="alert" className="notice notice--error" style={{ margin: "var(--space-3, 12px) auto", maxWidth: 720, textAlign: "center" }}>
      {message}
    </p>
  );
}
