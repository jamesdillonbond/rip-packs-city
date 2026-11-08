// lib/trophy/challenge-link.ts
//
// The deep link into a trophy challenge's spot on the dashboard (2026-11-07).
// Entering a challenge happens in the "More Trophy Cases" panel on the Trophy
// tab — below the main case, rendered only after its own fetch — so a bare
// `/dashboard` (which opens on Overview) left the collector hunting for it.
//
// ⚠ A QUERY PARAM, NOT A HASH. The first cut (same day) used
// `#challenge-<slug>`: a fragment never reaches the server, so the signed-out
// bounce to /login?next=<path+search> dropped it and the collector landed at
// the TOP of the Trophy tab. `?challenge=` rides `next` through login and the
// magic link. The hash form is still honoured for links already shared.

/** DOM id of a challenge's row/case in the dashboard trophy panel. */
export function challengeAnchorId(slug: string): string {
  return `challenge-${slug}`
}

/** Link that lands on the Trophy tab, scrolled to this challenge. */
export function challengeEntryHref(slug: string): string {
  return `/dashboard?tab=trophy&challenge=${encodeURIComponent(slug)}`
}

/** The challenge slug a dashboard URL asks to land on, or null. */
export function challengeFocusFromUrl(search: string, hash: string): string | null {
  const q = new URLSearchParams(search).get("challenge")
  if (q && /^[a-z0-9-]{1,80}$/.test(q)) return q
  const h = decodeURIComponent(hash.replace(/^#/, ""))
  const m = /^challenge-([a-z0-9-]{1,80})$/.exec(h)
  return m ? m[1] : null
}

/**
 * The SHAREABLE page of one collector's challenge entry (2026-11-07):
 * `/profile/<username>/trophy-case/<slug>` — its own page and its own social
 * card, so a pasted link unfurls as THEIR Dame Time case, not their profile.
 */
export function challengeCaseSharePath(username: string, slug: string): string {
  return `/profile/${encodeURIComponent(username)}/trophy-case/${encodeURIComponent(slug)}`
}

/** The social card for that page. */
export function challengeCaseOgPath(username: string, slug: string, token?: string | null): string {
  // `&s=` = the entry's contents (lib/og/card-url.ts pinsToken): a new pin is a new URL.
  const s = token ? `&s=${encodeURIComponent(token)}` : ""
  return `/api/og/trophy-case/${encodeURIComponent(username)}?case=${encodeURIComponent(slug)}${s}`
}

/** A challenge slug as the DB constrains it (`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 60). */
export function isChallengeSlug(s: string): boolean {
  return s.length <= 60 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)
}
