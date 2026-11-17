// lib/player-hub-path.ts — the player hub's URL (2026-10-22). A leaf module with
// no imports, so a client component or pure helper can build the link without
// pulling lib/player-hub.ts's server client in.

/** Canonical path for a player hub, /players/<slug>. */
export function playerHubPath(slug: string): string {
  return `/players/${encodeURIComponent(slug)}`
}
