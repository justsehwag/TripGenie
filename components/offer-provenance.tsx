import type { OfferMeta } from "@/lib/types";

/**
 * Shared offer-provenance presentation (Req 4.5/4.10/4.11, 24.9, 24.11, 24.12).
 *
 * Every offer the Booking_Site renders carries its `OfferMeta` and a visible
 * provenance label (`live | estimated | cached | demo`). When the payload
 * provenance is `estimated`, the surface additionally discloses that no payment
 * is taken and no valid ticket is issued (Req 24.12). These are presentational,
 * framework-only components that render exactly what the domain core produced —
 * they never fabricate a label or a disclaimer.
 */

const PROVENANCE_LABEL: Record<OfferMeta["mode"], string> = {
  live: "Live provider quote",
  estimated: "Estimated",
  cached: "Cached quote",
  demo: "Demo data",
};

/**
 * A small inline provenance badge for an offer card or detail page. Renders the
 * provenance mode and the offer's provider, so provenance is visible on every
 * offer surface (Req 24.9 / 24.11).
 */
export function ProvenanceLabel({ meta }: { meta: OfferMeta }) {
  return (
    <span
      className={`provenance provenance--${meta.mode}`}
      title={meta.disclaimer}
      data-provenance={meta.mode}
    >
      <span className="provenance__dot" aria-hidden="true" />
      <span className="provenance__text">
        {PROVENANCE_LABEL[meta.mode]} · {meta.provider}
      </span>
    </span>
  );
}

/**
 * The no-payment / no-ticket disclosure shown wherever an estimated flight offer
 * appears (Req 24.12). Renders nothing for non-estimated offers, so the notice
 * tracks the payload provenance exactly. Uses the offer's own disclaimer text
 * when present so the wording stays consistent with the domain core.
 */
export function EstimatedNotice({ meta }: { meta: OfferMeta }) {
  if (meta.mode !== "estimated") return null;
  return (
    <p className="estimated-notice" role="note">
      {meta.disclaimer ||
        "Estimated: no payment is taken and no valid ticket is issued."}
    </p>
  );
}

/**
 * The booking artifact each category issues, used only as a fallback phrasing
 * when the offer carries no disclaimer of its own.
 */
type OfferKind = "ticket" | "room" | "rental";

const KIND_FALLBACK: Record<OfferKind, string> = {
  ticket: "Estimated: no payment is taken and no valid ticket is issued.",
  room: "Estimated: no payment is taken and no valid room is issued.",
  rental: "Estimated: no payment is taken and no valid rental is issued.",
};

/**
 * Shared default-exported provenance block for any offer surface (flight, stay,
 * car). Renders the OfferMeta provenance label on every offer (Req 4.5/4.10,
 * 23.7, 24.9, 25.8) and, for estimated offers, the category-appropriate
 * no-payment disclosure (Req 23.10 / 24.12 / 25.11). The offer's own disclaimer
 * is preferred; `kind` only supplies the fallback wording.
 */
export default function OfferProvenance({
  meta,
  kind = "ticket",
}: {
  meta: OfferMeta;
  kind?: OfferKind;
}) {
  return (
    <div className="offer-provenance">
      <ProvenanceLabel meta={meta} />
      {meta.mode === "estimated" && (
        <p className="estimated-notice" role="note">
          {meta.disclaimer || KIND_FALLBACK[kind]}
        </p>
      )}
    </div>
  );
}
