// lib/franchise-hub-path.ts — a franchise hub's URL. A leaf module with no
// imports (moved out of lib/franchise-hub.ts 2026-10-22) so pure helpers such
// as lib/search/team-hub-hits.ts build the link without the server client.

/** Canonical path for a franchise hub, /teams/<league>/<slug>. */
export function franchiseHubPath(league: string, teamSlug: string): string {
  return `/teams/${league.toLowerCase()}/${encodeURIComponent(teamSlug)}`
}
