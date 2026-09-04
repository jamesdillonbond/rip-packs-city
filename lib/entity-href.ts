import { slugifyName } from "@/lib/entity-labels"

/**
 * The destination for a Moment's "who" link.
 *
 * ⚠ Top Shot's convention for a TEAM highlight is `player_name = team_name` — a *Clamps* Moment
 * of the Sacramento Kings stores "Sacramento Kings" in both fields. Linking that straight to
 * `/<collection>/player/<slug>` produces a **404**: measured 2026-09-04, all **370** Top Shot team
 * Moments do this and **not one of them has a `players` row**, so the link has never resolved for
 * any of them. `/<collection>/team/sacramento-kings` returns 200 and is the page the reader wants.
 *
 * This is not cosmetic on a public, crawled page type: 370 internal links to a 404 is a real
 * crawl-budget and user cost, and the reader who clicks a Moment's headline gets an error page.
 *
 * The rule is entirely local — a team Moment is exactly `playerName === teamName` — so no extra
 * data is needed anywhere this is called.
 */
export function momentSubjectHref(
  collectionUrlSlug: string,
  playerName: string | null | undefined,
  teamName: string | null | undefined,
): string | null {
  if (!playerName) return null
  const isTeamMoment = Boolean(teamName) && playerName.trim() === (teamName as string).trim()
  const kind = isTeamMoment ? "team" : "player"
  return `/${collectionUrlSlug}/${kind}/${encodeURIComponent(slugifyName(playerName))}`
}
