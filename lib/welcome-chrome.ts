/** Attribute name toggled on <html> while the welcome view (or its pending
 *  predecessor) is showing, so CSS can hide global chrome without touching
 *  GlobalNav/SiteFooter/SyncStatus. */
export const WELCOME_CHROME_ATTR = "data-welcome-gate";

/** True for the Welcome_Gate view values that must hide Global_Chrome. */
export function hidesChrome(view: "pending" | "welcome" | "app"): boolean {
  return view === "pending" || view === "welcome";
}
