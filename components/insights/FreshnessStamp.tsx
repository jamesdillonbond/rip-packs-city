"use client";

import { useEffect, useState } from "react";

/**
 * Renders a server-stamped ISO timestamp as a human "as of" string.
 *
 * TWO-PHASE, HYDRATION-SAFE, VIEWER-LOCAL (changed 2026-08-05)
 * -----------------------------------------------------------
 * History: an even earlier version returned a literal "—" during SSR and the
 * first client render, then filled the value in a useEffect — so the SERVED HTML
 * of every public board permanently read "—" where its freshness stamp belonged
 * (crawlers, unfurlers, and no-JS readers saw nothing; verified live 2026-08-01
 * on /insights/candy-mlb). That was fixed by formatting deterministically in UTC
 * from getUTC* parts so server and client produce byte-identical text.
 *
 * This version keeps that crawler/SSR guarantee AND shows the time in the
 * VIEWER'S timezone (requested 2026-08-05):
 *   - `formatFreshness` (UTC, deterministic) is the initial state, so the server
 *     render and the FIRST client render are byte-identical — nothing to hydrate
 *     around, and the served HTML still carries a real UTC timestamp for anyone
 *     without JS.
 *   - After mount, an effect swaps in `formatLocal` (the viewer's zone, self-
 *     labelled e.g. "PDT"). That is a normal post-hydration state update, so it
 *     produces no React #418 mismatch.
 *
 * "—" still means only: no timestamp was supplied.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Deterministic "Jun 1, 2026, 12:34 UTC". Built from getUTC* parts rather than
 * toLocaleString/Intl so it cannot vary by runtime locale, ICU build, or
 * timezone — the three things that made an earlier version hydration-unsafe.
 * This is the SSR + first-client-render value.
 */
export function formatFreshness(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/**
 * Viewer-local "Jun 1, 2026, 7:34 AM PDT". Runs ONLY after mount (client-only),
 * so the runtime timezone is the viewer's; self-labels the zone via
 * timeZoneName so the reader knows which clock it is.
 */
export function formatLocal(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function FreshnessStamp({ iso }: { iso: string | null | undefined }) {
  const utcText = formatFreshness(iso);
  // Initial state = the deterministic UTC text, so SSR and the first client
  // render match exactly. Swap to the viewer's local zone after mount.
  const [text, setText] = useState<string | null>(utcText);
  useEffect(() => {
    setText(formatLocal(iso) ?? formatFreshness(iso));
  }, [iso]);
  if (!utcText) return <>—</>;
  // <time> gives crawlers and assistive tech the machine-readable instant while
  // the visible text is UTC on first paint, then the viewer's local zone.
  return <time dateTime={new Date(iso as string).toISOString()}>{text ?? utcText}</time>;
}
