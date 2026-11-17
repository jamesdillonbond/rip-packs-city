// lib/team-denylist.ts
// Team Hub polish (P1). Exhibition / all-star rosters carry a `team_name` in
// `editions` but are NOT real franchises — they generate junk team-hub URLs
// (e.g. /nba-top-shot/team/team-lebron) that pollute the sitemap and render as
// malformed franchise pages. This is a precise DENYLIST of the ~12 stable
// exhibition names, NOT a "not in teams_master" filter: a teams_master filter
// would wrongly 404 the real WNBA franchises (New York Liberty, Las Vegas Aces,
// …) and historical/relocated NBA franchises (Seattle SuperSonics, New Jersey
// Nets, Washington Bullets, …), which legitimately have no teams_master row.
//
// Slugs use the canonical slugifyName() form (= the Postgres
// regexp_replace(lower(trim(x)),'[^a-z0-9]+','-','g') expression) so they
// match the URL segment and the sitemap teamMap key directly.

/**
 * Slugified exhibition / all-star roster names that must not produce a team hub.
 * Verified against a fresh DISTINCT team_name query (2026-05-31): these 12 are
 * the only true junk; everything else (WNBA + historical franchises) is kept.
 */
export const EXHIBITION_TEAM_SLUGS: ReadonlySet<string> = new Set([
  "team-lebron",
  "team-durant",
  "team-giannis",
  "team-wilson",
  "team-stewart",
  "eastern-conference-all-stars",
  "western-conference-all-stars",
  "young-stars",
  "ogs",
  "global-stars",
  "rookie-team",
  "sophomore-team",
])

/** True when the slug is an exhibition/all-star roster that should not get a team hub. */
export function isExhibitionTeamSlug(slug: string): boolean {
  return EXHIBITION_TEAM_SLUGS.has(slug.trim().toLowerCase())
}
