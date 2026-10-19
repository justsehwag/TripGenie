import ResultsSkeleton from "@/components/results-skeleton";

/**
 * Flights Results_Page loading placeholder (Req 28.2). Shown while the
 * `flights/page.tsx` server segment awaits the Search_API.
 */
export default function FlightsLoading() {
  return <ResultsSkeleton eyebrow="Flights" />;
}
