// lib/rookie-class-link.ts — the rookie boards' class in the URL (2026-10-23).
//
// Both rookie boards (/insights/rookies, /insights/rookie-board) gained a
// 2025 / 2026 CLASS tab on 10-22 as CLIENT state, and their APIs honour
// `?class=`; the PAGES did not, so the 2026 class had no shareable link — the
// share button copied the bare path and `/insights/rookie-board?class=2026`
// rendered the 2025 default (390 px sweep, 10-22 ~11:30 PM PT).
//
// Why not `searchParams` on the page or `useSearchParams()` in the client: both
// pages are ISR (revalidate 300 / 900); the server prop would make them dynamic,
// and `useSearchParams` demands a Suspense boundary to keep the static shell.
// So the client seeds its tab from `window.location.search` once, after mount
// (`readRookieClassParam`), and the share URL carries the class back out
// (`rookieBoardShareUrl`). The default class stays bare so the canonical URL is
// unchanged for the 2025 board. A leaf module: no imports.

/** The class a board shows when the URL names none. */
export const DEFAULT_ROOKIE_CLASS = "2025"

/**
 * The `class` the URL asks for, when it names one the board knows; null
 * otherwise (absent, unknown, or an unparsable search string). Never throws.
 */
export function readRookieClassParam(search: string, classes: readonly string[]): string | null {
  try {
    const c = new URLSearchParams(search).get("class")
    return c !== null && classes.includes(c) ? c : null
  } catch {
    return null
  }
}

/** The board's share URL: bare for the default class, `?class=<cls>` otherwise. */
export function rookieBoardShareUrl(base: string, cls: string): string {
  return cls === DEFAULT_ROOKIE_CLASS ? base : `${base}?class=${encodeURIComponent(cls)}`
}
