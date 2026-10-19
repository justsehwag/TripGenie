import ResultsSkeleton from "@/components/results-skeleton";

/**
 * Stays Results_Page loading placeholder (Req 28.2). Next renders this while the
 * `stays/page.tsx` server segment awaits the Search_API, replacing the pending
 * results with a calm, overflow-free skeleton until the offers resolve.
 */
export default function StaysLoading() {
  return <ResultsSkeleton eyebrow="Stays" />;
}
