/**
 * Shared Asia/Kolkata (IST) time helpers.
 *
 * Pure module: no fetch, no React, no process.env. Every formatter uses a fixed
 * locale and time zone so server and client render identical text.
 */

export const IST = "Asia/Kolkata";

/**
 * Fixed-timezone numeric parts for the label ("30 Oct, 4:05 pm"). Month names
 * come from a fixed table because ICU's en-IN short month varies by version
 * (e.g. "Sept"), which would break the `d MMM` shape and server/client parity.
 */
const CHECKED_FMT = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: IST,
});
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatChecked(d: Date): string {
  const p: Record<string, string> = {};
  for (const part of CHECKED_FMT.formatToParts(d)) p[part.type] = part.value;
  const month = MONTHS[Number(p.month) - 1];
  return `${Number(p.day)} ${month}, ${Number(p.hour)}:${p.minute} ${p.dayPeriod.toLowerCase()}`;
}

/** Calendar parts (year, month, day) of an instant in IST. */
const DATE_PARTS_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function istParts(now: Date): { year: string; month: string; day: string } {
  let year = "";
  let month = "";
  let day = "";
  for (const p of DATE_PARTS_FMT.formatToParts(now)) {
    if (p.type === "year") year = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
  }
  return { year, month, day };
}

/** "30 Oct, 4:05 pm IST" from a fixed en-IN formatter in Asia/Kolkata; "just now" for an unparsable ISO. */
export function checkedLabel(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${formatChecked(new Date(t))} IST` : "just now";
}

/** YYYY-MM-DD for the instant in Asia/Kolkata. */
export function todayIst(now: Date = new Date()): string {
  const { year, month, day } = istParts(now);
  return `${year}-${month}-${day}`;
}

/** YYYY-MM for the instant in Asia/Kolkata; the Usage_Guard month key. */
export function istMonthKey(now: Date): string {
  const { year, month } = istParts(now);
  return `${year}-${month}`;
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Days since the epoch for the calendar date at the start of "YYYY-MM-DD[ HH:MM]", or null. */
function calendarDay(local: string): number | null {
  const m = LOCAL_DATE_RE.exec(local.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/**
 * Whole-day difference between two "YYYY-MM-DD[ HH:MM]" local timestamps
 * (arrival day offset, Req 4.6). Compares calendar dates only; 0 when either
 * timestamp has no parsable date.
 */
export function dayOffset(departLocal: string, arriveLocal: string): number {
  const d = calendarDay(departLocal);
  const a = calendarDay(arriveLocal);
  if (d === null || a === null) return 0;
  return a - d;
}
