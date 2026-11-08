// lib/og/card-url.ts
//
// The og:image URLs of the profile, trophy-case and challenge-entry cards — ONE
// set of builders, used by the page metadata, the share buttons' prewarm and the
// server-side warm after a pin changes, so all three name the same URL.
// Client-safe (no server imports).
//
// ⚠ `?v=` IS A CACHE KEY FOR OTHER PEOPLE'S CACHES (2026-11-07). Discord's media
// proxy keys an embed image by its URL and REMEMBERS A FAILURE: peanpean's card
// timed out at 7:16 PM PT (cold renders ran ~11 s, before lib/og/card-store),
// and an hour later — with the card stored and served 200 in well under a
// second — a fresh paste still showed Discord's broken-image placeholder, while
// a never-fetched card URL rendered fine. Bump it again only for the same reason.
//
// ⚠ `&s=` IS THE CASE'S CONTENT (2026-11-07, later). tetrislblock's Dame Time
// card was rendered after their FIRST pin (the share buttons appear then and
// prewarm it) and stored; they pinned five more within a minute, and the link
// they pasted unfurled with ONE Moment — the store held it as fresh for 10 min
// and the URL never changed, so iMessage/Discord keep it too. The token is a
// hash of what is pinned where: a pin, unpin or reorder is a NEW URL, so every
// cache — ours and theirs — sees a new image. The routes key the store on it.
export const OG_CARD_URL_VERSION = "2"

/** A short, stable hash of a case's contents (slot + moment). "0" for empty. */
export function pinsToken(pins: ReadonlyArray<{ slot?: unknown; moment_id?: unknown }> | null | undefined): string {
  const parts = (pins ?? [])
    .filter((p) => p && p.moment_id != null)
    .map((p) => `${Number(p.slot ?? 0)}:${String(p.moment_id)}`)
    .sort()
  if (parts.length === 0) return "0"
  // FNV-1a, 32-bit — a cache key, not a security boundary.
  let h = 0x811c9dc5
  for (const ch of parts.join("|")) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** A state token as the routes accept it (base36, short). */
export function cleanCardToken(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().toLowerCase()
  return /^[0-9a-z]{1,13}$/.test(t) ? t : null
}

const tok = (token?: string | null) => (token ? `&s=${encodeURIComponent(token)}` : "")

export function ogProfileCardPath(username: string, token?: string | null): string {
  return `/api/og/profile/${encodeURIComponent(username)}?v=${OG_CARD_URL_VERSION}${tok(token)}`
}

export function ogTrophyCaseCardPath(username: string, token?: string | null): string {
  return `/api/og/trophy-case/${encodeURIComponent(username)}?v=${OG_CARD_URL_VERSION}${tok(token)}`
}
