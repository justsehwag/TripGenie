"use client";

/**
 * BookingRequestButton - a reusable, presentational outbound booking control
 * (Req 5.5, 5.6, 5.7, 20.5). It renders the control that sends the Traveller to
 * the booking site in a new browsing context. TripGenie takes no payment; this
 * only opens the provider's own booking request.
 *
 * Two shapes are supported, both opening in a new tab with
 * `rel="noopener noreferrer"`:
 *  - POST: when the provider supplied `post_data`, the request is replayed as a
 *    native HTML `<form method="post">` with one hidden input per field, so the
 *    browser posts the body to the https action URL (Req 5.7).
 *  - GET: when there is no POST body (e.g. a hotel website link or a GET booking
 *    URL), a plain `<a>` is rendered instead (Req 5.6).
 *
 * Link safety (Req 20.5): the control is rendered only for an `https:` URL. Any
 * other scheme renders nothing, so no insecure outbound link is ever shown.
 *
 * The accessible name always states the link opens in a new tab, e.g.
 * visible "Book on MakeMyTrip \u2197" with aria-label
 * "Book on MakeMyTrip (opens in a new tab)" (Req 5.6).
 *
 * Kept generic (no server-only import) so it is reusable by both the hotel
 * offers panel (GET website/booking links) and the flight booking panel (POST
 * booking requests) without pulling a server module into a client bundle.
 */

/** Generic shape mirroring `FlightBookingOption.request` plus display fields. */
export interface BookingRequestButtonProps {
  /** Booking site name, e.g. "MakeMyTrip". Used in the accessible name. */
  source: string;
  /** Booking request URL. Rendered only when it uses the https scheme. */
  url: string;
  /** POST replays the body as a form; GET renders a plain anchor. */
  method: "POST" | "GET";
  /** `[name, value]` pairs for the POST body; ignored for GET. */
  fields?: [string, string][];
  /** Optional booking-site logo (https only); shown when supplied. */
  logo?: string | null;
  /** Optional price to surface on the control; shown when supplied. */
  price?: number | null;
}

/** True only for a well-formed absolute https URL (defensive link check). */
function isHttps(url: string): boolean {
  if (!url.startsWith("https://")) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export function BookingRequestButton({
  source,
  url,
  method,
  fields,
  logo,
  price,
}: BookingRequestButtonProps) {
  // Link safety: never render a non-https outbound link (Req 20.5).
  if (!isHttps(url)) return null;

  const accessibleName = `Book on ${source} (opens in a new tab)`;
  const label = (
    <span className="booking-request__label">
      {logo ? (
        <img
          className="booking-request__logo"
          src={logo}
          alt=""
          aria-hidden="true"
          width={20}
          height={20}
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      ) : null}
      <span className="booking-request__text">
        Book on {source} {"\u2197"}
      </span>
      {typeof price === "number" && price > 0 ? (
        <span className="booking-request__price">{inr.format(price)}</span>
      ) : null}
    </span>
  );

  // POST: replay the provider's booking request body as a native HTML form so
  // the browser performs the POST to the https action in a new tab (Req 5.7).
  if (method === "POST") {
    return (
      <form
        className="booking-request booking-request--post cta"
        method="post"
        action={url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {(fields ?? []).map(([name, value], i) => (
          <input key={`${name}-${i}`} type="hidden" name={name} value={value} />
        ))}
        <button type="submit" className="booking-request__submit" aria-label={accessibleName}>
          {label}
        </button>
      </form>
    );
  }

  // GET: a plain outbound anchor for website/booking links (Req 5.6).
  return (
    <a
      className="booking-request booking-request--get cta"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={accessibleName}
    >
      {label}
    </a>
  );
}

export default BookingRequestButton;
