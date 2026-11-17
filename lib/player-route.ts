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

/**
 * A "player" row whose subject IS its team (2026-10-31). All Day's team-level Moments
 * (team defense, team celebrations) list the TEAM as the player, so
 * /nfl-all-day/player/detroit-lions is a real page — but "Follow player" there would
 * follow a team as a person. Callers send that follow to the team page instead.
 * Measured 2026-10-31: 33 All Day rows (one per NFL franchise).
 */
export function isTeamSubject(collectionUrlSlug: string, d: { name?: string | null; team?: string | null; player_slug?: string | null; team_slug?: string | null }): boolean {
  // ⛔ Never Pinnacle: a character's "team" is its FRANCHISE, and 15 characters share
  // their franchise's name (Aladdin, Bambi, Dumbo…) — they are followable characters.
  if (isPinnacleUrlSlug(collectionUrlSlug)) return false
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase()
  if (norm(d.player_slug) && norm(d.player_slug) === norm(d.team_slug)) return true
  return norm(d.name) !== "" && norm(d.name) === norm(d.team)
}
