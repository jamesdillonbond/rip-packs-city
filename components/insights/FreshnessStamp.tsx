"use client";

/**
 * Renders a server-stamped ISO timestamp as a human "as of" string.
 *
 * WHY THIS IS NOT `toLocaleString()` IN AN EFFECT (changed 2026-08-01)
 * -------------------------------------------------------------------
 * The previous implementation returned a literal "—" during SSR and the first
 * client render, then filled the localized value in a useEffect. That avoided
 * the React #418 hydration-drift warning (toLocaleString formats in the runtime
 * timezone: UTC on the Vercel server, local in the browser) but it meant the
 * SERVED HTML of every public board permanently read "—" where its freshness
 * stamp should be. Verified live on 2026-08-01: /insights/candy-mlb shipped
 * "...scarcity, and pack EV. —". That is what crawlers, link unfurlers, and any
 * no-JS reader saw — a board asserting market intelligence while unable to say
 * how fresh it was. It affected all 18 boards that use this component, not just
 * the two it was reported on.
 *
 * The fix removes the drift at the source instead of hiding it: format in a
 * FIXED timezone (UTC) using explicit, locale-independent parts. The output is
 * a pure function of the ISO string, so server and client produce byte-identical
 * text and there is nothing to hydrate around — no effect, no placeholder, no
 * mismatch. UTC is also the honest choice for a data-freshness stamp: it is the
 * timezone every backing pipeline records in, and it does not silently reinterpret
 * the same instant differently for two readers.
 *
 * "—" is now reserved for its real meaning: no timestamp was supplied.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Deterministic "Jun 1, 2026, 12:34 UTC". Built from getUTC* parts rather than
 * toLocaleString/Intl so it cannot vary by runtime locale, ICU build, or
 * timezone — the three things that made the old version hydration-unsafe.
 */
export function formatFreshness(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

export function FreshnessStamp({ iso }: { iso: string | null | undefined }) {
  const text = formatFreshness(iso);
  if (!text) return <>—</>;
  // <time> gives crawlers and assistive tech the machine-readable instant while
  // the visible text stays the stable UTC string.
  return <time dateTime={new Date(iso as string).toISOString()}>{text}</time>;
}
