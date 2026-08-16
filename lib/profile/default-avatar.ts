// lib/profile/default-avatar.ts
//
// The avatar a collector gets before they set one: the RPC logo.
//
// WHY THIS IS A RENDER-TIME DEFAULT AND NOT A COLUMN DEFAULT + BACKFILL.
// `profile_bio.avatar_url` stays NULL for anyone who has not chosen an avatar,
// and NULL keeps meaning exactly that. Three things follow, and each is a
// reason the DB route was rejected:
//   1. A new signup is covered the moment their row is created, with no
//      backfill to remember. ⚠ A column DEFAULT would NOT have done this:
//      `app/api/profile/bio/route.ts` POSTs `avatar_url: avatarUrl ?? null`,
//      and an EXPLICIT NULL defeats a DEFAULT — the default would have been
//      silently inert on the main creation path while looking correct.
//   2. Changing the default later is a one-line edit here, not an UPDATE over
//      every row that happens to still hold the old URL.
//   3. It stays possible to tell "chose the logo" from "never set one". Writing
//      the logo into every row destroys that distinction permanently, and it is
//      the distinction you need to answer "who has actually personalised?".
//
// ⚠ ABSOLUTE, NOT `/rip-packs-city-logo.png`, AND THAT IS LOAD-BEARING. Two
// consumers resolve this URL server-side with no browser to make it absolute:
// the profile OG card (`app/api/og/profile/[username]/route.tsx`, edge) and the
// trophy-case PDF. The OG card additionally refuses to embed anything that does
// not `startsWith("https://")`, so a relative path there would silently render
// the monogram on every card instead.
//
// ⚠ The path is an exact member of `STATIC_ROOT_ASSETS` in `proxy.ts`. It must
// stay one. If it is ever moved somewhere the auth wall gates, those two
// server-side fetches do not get a 404 — the wall 302s to `/login` and hands
// them an HTML document at status 200, which satori then dies on from inside
// the ImageResponse stream (the `/fonts/*.ttf` failure, 2026-08-13).

export const DEFAULT_AVATAR_URL =
  "https://www.rippackscity.com/rip-packs-city-logo.png"

/**
 * The avatar URL to render for a collector.
 *
 * Returns the collector's own avatar when they have set one, else the RPC
 * logo. "Set one" means a non-blank string — NULL, undefined and whitespace
 * are all the unset state.
 *
 * ⚠ It does NOT validate the URL. A collector who saved a broken value keeps
 * getting their broken value: substituting the logo for it would hide their
 * own mistake behind something that looks deliberate, and every render site
 * already degrades a failed image load to the monogram.
 */
export function resolveAvatarUrl(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_AVATAR_URL
  const trimmed = raw.trim()
  return trimmed === "" ? DEFAULT_AVATAR_URL : trimmed
}

/** True when the collector has not chosen an avatar and is on the default. */
export function isDefaultAvatar(raw: string | null | undefined): boolean {
  return resolveAvatarUrl(raw) === DEFAULT_AVATAR_URL
}
