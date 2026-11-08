// lib/trophy/challenge-link.ts
//
// The deep link into a trophy challenge's spot on the dashboard (2026-11-07).
// Entering a challenge happens in the "More Trophy Cases" panel on the Trophy
// tab — below the main case, rendered only after its own fetch — so a bare
// `/dashboard` (which opens on Overview) left the collector hunting for it.
// The hash names the challenge's row (the "Enter" prompt before entering, the
// case itself after), and the panel scrolls to it once it has loaded.

/** DOM id of a challenge's row/case in the dashboard trophy panel. */
export function challengeAnchorId(slug: string): string {
  return `challenge-${slug}`
}

/** Link that lands on the Trophy tab, scrolled to this challenge. */
export function challengeEntryHref(slug: string): string {
  return `/dashboard?tab=trophy#${challengeAnchorId(slug)}`
}
