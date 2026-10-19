import ResultsSkeleton from "@/components/results-skeleton";

/**
 * Cars Results_Page loading placeholder (Req 28.2). Shown while the
 * `cars/page.tsx` server segment awaits the Search_API.
 */
export default function CarsLoading() {
  return <ResultsSkeleton eyebrow="Car rental" />;
}
