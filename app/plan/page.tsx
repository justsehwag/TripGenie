import ConciergeHome from "@/components/concierge-home";

/**
 * AI Travel Assistant route (Req 21). `/plan` is now served by the SAME
 * concierge experience as `/`, in its "assistant" presentation: a serif page
 * header above the conversational planner + Live_Trip_Profile. The legacy
 * `Planner` component is no longer routed to (left on disk).
 *
 * A SERVER component. It reads `searchParams` (a Promise in Next 16, matching
 * app/stays/page.tsx), awaits them, and forwards the single `q` value as
 * `initialQuery` so the concierge seeds the conversation once on mount and the
 * profile pre-fills from a homepage hand-off (Req 21.10).
 */
export const metadata = { title: "AI Travel Assistant - TripGenie" };

/** Next 16 passes searchParams as a Promise of a string→string|string[] map. */
type SearchParams = Record<string, string | string[] | undefined>;

/** Read a single string value from the raw searchParams map. */
function one(params: SearchParams, key: string): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const raw = await searchParams;
  const q = one(raw, "q") ?? "";
  return <ConciergeHome variant="assistant" initialQuery={q} />;
}
