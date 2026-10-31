// lib/player-route.ts
//
// The URL segment for a collection's player page (2026-10-31, Trevor: "refer to
// Pinnacle assets as characters"). Disney Pinnacle's are CHARACTERS, so their page
// lives at /disney-pinnacle/character/<slug>; every other collection keeps
// /<collection>/player/<slug>. The old /disney-pinnacle/player/<slug> answers a
// 308 to the character URL (next.config.ts), so every link and indexed URL keeps
// working; builders use this helper so in-app links skip that hop.

import { isPinnacleUrlSlug } from "@/lib/collection-slug"

export type PlayerSegment = "player" | "character"

export function playerSegment(collectionUrlSlug: string): PlayerSegment {
  return isPinnacleUrlSlug(collectionUrlSlug) ? "character" : "player"
}

/** `/<collection>/player/<slug>` — or `/disney-pinnacle/character/<slug>`. `slug` is encoded here. */
export function playerPagePath(collectionUrlSlug: string, slug: string): string {
  return `/${collectionUrlSlug}/${playerSegment(collectionUrlSlug)}/${encodeURIComponent(slug)}`
}
