// lib/og/card-url.ts
//
// The og:image URLs of the profile and trophy-case cards — ONE builder, used by
// the page metadata and by the share buttons' prewarm, so both name the same
// URL. Client-safe (no server imports).
//
// ⚠ `?v=` IS A CACHE KEY FOR OTHER PEOPLE'S CACHES (2026-11-07). Discord's media
// proxy keys an embed image by its URL and REMEMBERS A FAILURE: peanpean's card
// timed out at 7:16 PM PT (cold renders ran ~11 s, before lib/og/card-store),
// and an hour later — with the card stored and served 200 in well under a
// second — a fresh paste still showed Discord's broken-image placeholder, while
// a never-fetched card URL (a Dame Time entry) rendered fine. Bumping the
// version is the only lever on a cache we do not own. Bump it again only for
// the same reason; the routes ignore the parameter.
export const OG_CARD_URL_VERSION = "2"

export function ogProfileCardPath(username: string): string {
  return `/api/og/profile/${encodeURIComponent(username)}?v=${OG_CARD_URL_VERSION}`
}

export function ogTrophyCaseCardPath(username: string): string {
  return `/api/og/trophy-case/${encodeURIComponent(username)}?v=${OG_CARD_URL_VERSION}`
}
