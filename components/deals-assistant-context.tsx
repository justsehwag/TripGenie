"use client";

import { usePageAssistantContext } from "@/components/use-page-assistant-context";

/** One bookable deal as the assistant sees it. */
export interface AssistantDeal {
  title: string;
  priceLabel: string;
}

const MAX_DEALS = 20;

/**
 * Registers the Deals page context with the site assistant. Renders nothing.
 * No page actions; navigation (goTo) is handled globally.
 */
export default function DealsAssistantContext({ deals }: { deals: AssistantDeal[] }) {
  const visible = deals.slice(0, MAX_DEALS).map((d) => ({ title: d.title, priceLabel: d.priceLabel }));
  const summary =
    visible.length > 0 ? `Deals page, ${visible.length} deal(s) shown.` : "Deals page, no deals shown.";

  usePageAssistantContext({ page: "deals", slot: "results", summary, data: { deals: visible } });
  return null;
}
