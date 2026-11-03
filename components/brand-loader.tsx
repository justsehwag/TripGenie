/**
 * BrandLoader - the TripGenie branded loading animation (Render/loading.svg,
 * served from /public as brand-loading.svg). The SVG animates itself (SMIL),
 * so there is no runtime dependency and it works inside a server component.
 *
 * Presentational only. It exposes an accessible busy status to assistive tech
 * via role="status" + aria-live, with a visually-hidden label, and honours
 * reduced motion through the CSS (the animation is paused under
 * prefers-reduced-motion in globals.css). `label` sets the announced text and
 * `size` scales the mark; the aspect ratio (292x218) is preserved.
 */
export default function BrandLoader({
  label = "Loading",
  size = 150,
  className,
}: {
  label?: string;
  size?: number;
  className?: string;
}) {
  const width = Math.max(72, Math.round(size));
  const height = Math.round((width * 218) / 292);
  return (
    <div
      className={`brand-loader${className ? ` ${className}` : ""}`}
      role="status"
      aria-live="polite"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="brand-loader__mark"
        src="/brand-loading.svg"
        width={width}
        height={height}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <span className="brand-loader__label">{label}{"\u2026"}</span>
      <span className="sr-only">{label}, please wait.</span>
    </div>
  );
}