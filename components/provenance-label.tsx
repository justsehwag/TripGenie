import type { OfferMeta, Provenance } from "@/lib/types";

/**
 * Shared, presentational Payload_Provenance label (design "Booking Site ▸
 * Honesty Carried Forward", Req 4.10/4.11). Every offer the Booking_Site
 * renders — on a Results_Page card or a Detail_Page — carries a visible
 * provenance label drawn from its `OfferMeta.mode` (`live | estimated |
 * cached | demo`). This component is the single place that formatting lives,
 * so provenance labelling is uniform and mandatory across every card
 * (Req 25.8 / 25.10, reuses the discipline behind Properties 20-22).
 *
 * It renders nothing beyond what the domain core produced: the label text is
 * the provenance value, and the disclosure is `OfferMeta.disclaimer` verbatim
 * (for an estimated offer that disclaimer already states no payment is taken
 * and no valid ticket/room/rental is issued — Req 25.11).
 */

const PROVENANCE_TEXT: Record<Provenance, string> = {
  live: "Live quote",
  estimated: "Estimated",
  cached: "Cached",
  demo: "Demo",
};

export function provenanceLabelText(mode: Provenance): string {
  return PROVENANCE_TEXT[mode];
}

export default function ProvenanceLabel({ meta }: { meta: OfferMeta }) {
  const estimated = meta.mode === "estimated";
  return (
    <p className={`provenance provenance--${meta.mode}`}>
      <span className="provenance__badge" data-mode={meta.mode}>
        {provenanceLabelText(meta.mode)}
      </span>
      {/* The disclaimer is produced by the Inventory Adapter; for estimated
          offers it already states no payment / no valid rental (Req 25.11). */}
      <span className={`provenance__note${estimated ? " provenance__note--estimated" : ""}`}>
        {meta.disclaimer}
      </span>
    </p>
  );
}
