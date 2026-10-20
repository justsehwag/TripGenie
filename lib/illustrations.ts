/**
 * Illustration_Library registry (ui-redesign).
 *
 * Framework-free module: NO `"use client"`, NO JSX, no React/Next imports.
 * It is a plain data/lookup module so both server and client components can
 * import it directly and resolve an illustration asset by id.
 *
 * Each asset points at a locally stored SVG under `public/illustrations/`
 * (served from the site root as `/illustrations/<id>.svg`). The illustrations
 * form one cohesive emerald/mint family with restrained orange accents
 * (no emoji, stock, cartoon-mix, or 3D) — see the SVG sources.
 *
 * Components reference illustrations only via `illustration(id)`, which
 * guarantees a shared concept resolves to the same asset (Requirement 17.5)
 * and that an unknown id fails fast (Requirement 17.4, Error Handling).
 */

/** The seven cohesive travel illustrations in the library (Requirement 17.4). */
export type IllustrationId =
  | "traveler-globe"
  | "location-pin"
  | "hot-air-balloon"
  | "tropical-plant"
  | "winding-path"
  | "suitcase"
  | "abstract-landscape";

export interface IllustrationAsset {
  id: IllustrationId;
  /** Public path to the local SVG asset, e.g. "/illustrations/traveler-globe.svg". */
  src: string;
  /** Intrinsic width so aspect ratio is preserved on resize (Req 19.2). */
  width: number;
  /** Intrinsic height so aspect ratio is preserved on resize (Req 19.2). */
  height: number;
  /** Required descriptive, non-empty alt text. */
  alt: string;
}

/**
 * The single source of truth for every library illustration. Each `src` is the
 * public path to the matching SVG, and `width`/`height` equal that SVG's
 * intrinsic viewBox dimensions (240×240) so the rendered aspect ratio is
 * preserved across viewports (Requirement 19.2).
 */
export const ILLUSTRATIONS: Record<IllustrationId, IllustrationAsset> = {
  "traveler-globe": {
    id: "traveler-globe",
    src: "/illustrations/traveler-globe.svg",
    width: 240,
    height: 240,
    alt: "A traveler's globe crossed with a route flag, exploring the world",
  },
  "location-pin": {
    id: "location-pin",
    src: "/illustrations/location-pin.svg",
    width: 240,
    height: 240,
    alt: "A floating map location pin marking a destination",
  },
  "hot-air-balloon": {
    id: "hot-air-balloon",
    src: "/illustrations/hot-air-balloon.svg",
    width: 240,
    height: 240,
    alt: "A hot-air balloon drifting over an open sky",
  },
  "tropical-plant": {
    id: "tropical-plant",
    src: "/illustrations/tropical-plant.svg",
    width: 240,
    height: 240,
    alt: "A potted tropical plant with broad leaves",
  },
  "winding-path": {
    id: "winding-path",
    src: "/illustrations/winding-path.svg",
    width: 240,
    height: 240,
    alt: "A map with a winding dashed path between two markers",
  },
  suitcase: {
    id: "suitcase",
    src: "/illustrations/suitcase.svg",
    width: 240,
    height: 240,
    alt: "A packed travel suitcase with straps and buckles",
  },
  "abstract-landscape": {
    id: "abstract-landscape",
    src: "/illustrations/abstract-landscape.svg",
    width: 240,
    height: 240,
    alt: "An abstract rolling landscape with hills and a rising sun",
  },
};

/**
 * Resolve an illustration asset by id.
 *
 * Returns the matching {@link IllustrationAsset}. Throws a descriptive error
 * for an unknown id so a mistyped or missing concept fails fast at the call
 * site in development and build rather than rendering a broken image
 * (Requirement 17.4, Error Handling).
 */
export function illustration(id: IllustrationId): IllustrationAsset {
  const asset = ILLUSTRATIONS[id];
  if (!asset) {
    throw new Error(
      `Unknown illustration id: "${String(id)}". Valid ids: ${Object.keys(
        ILLUSTRATIONS,
      ).join(", ")}.`,
    );
  }
  return asset;
}
