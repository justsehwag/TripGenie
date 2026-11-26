/**
 * First-visit welcome gate helpers (pure decision plus guarded storage).
 *
 * The flag is set when the visitor chooses guest mode or is found signed in.
 * Showing the welcome page alone does not set it. It uses a key that
 * `clearLocalAccountState` does not remove, so it survives sign-out.
 */
import { ACCOUNT_MAX_TRIPS, GUEST_MAX_TRIPS } from "@/lib/trip-retention";

export const WELCOME_SEEN_KEY = "tripgenie.welcome.v1";

export type WelcomeSession = "unknown" | "signed-in" | "guest" | "error";

export interface WelcomeInput {
  seen: boolean;
  storageOk: boolean;
  session: WelcomeSession;
}

export interface WelcomeDecision {
  view: "pending" | "welcome" | "app";
  markSeen: boolean;
}

export function decideWelcome(i: WelcomeInput): WelcomeDecision {
  if (!i.storageOk || i.seen) return { view: "app", markSeen: false };
  switch (i.session) {
    case "unknown":
      return { view: "pending", markSeen: false };
    case "signed-in":
      return { view: "app", markSeen: true };
    case "guest":
      return { view: "welcome", markSeen: false };
    default:
      return { view: "app", markSeen: false };
  }
}

export function readWelcomeSeen(): { seen: boolean; storageOk: boolean } {
  try {
    if (typeof localStorage === "undefined") return { seen: false, storageOk: false };
    return { seen: localStorage.getItem(WELCOME_SEEN_KEY) === "1", storageOk: true };
  } catch {
    return { seen: false, storageOk: false };
  }
}

export function markWelcomeSeen(): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(WELCOME_SEEN_KEY, "1");
  } catch {
    /* storage unavailable: nothing to do */
  }
}

export const GUEST_LIMIT_LINES: readonly string[] = [
  `Trips are saved on this device only. This device keeps your newest ${GUEST_MAX_TRIPS} trips; a signed-in account keeps the newest ${ACCOUNT_MAX_TRIPS}.`,
  "Your trips will not appear on other devices.",
  "XP is earned and stored only while signed in.",
];
