import { slugifyName, slugifyPlayerName } from "@/lib/entity-labels"

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
  const slug = isTeamMoment ? slugifyName(playerName) : slugifyPlayerName(playerName)
  return `/${collectionUrlSlug}/${kind}/${encodeURIComponent(slug)}`
}

/**
 * The display name for a Moment's "who". Top Shot stores a team highlight as
 * `player_name = NULL, team_name = <franchise>` (151 canonical editions on
 * 2026-09-06, 151/151 with a team_name), so a bare `player_name ?? "Unknown"`
 * publishes the word "Unknown" as if it were the subject — it rendered on the
 * pack page's "Top chases" strip ("Unknown · Squad Goals · $3.74"). The subject
 * is the team, then the set, and only then an honest dash. Never "Unknown":
 * that reads as a fact about the Moment, and it is a fact about our join.
 */
/**
 * The canonical edition-page href for an edition row that carries its
 * `external_id`. Added 2026-09-07 (Search Console pass): four "related /
 * parallel" blocks linked to `/moment/<edition uuid>`, which is the edition
 * page under another URL — it now 308s there, so every such internal link was
 * a redirect hop for the reader and a duplicate URL for the crawler (~11,000
 * of them in the not-indexed buckets). Link straight to the canonical.
 *
 * ⚠ Pinnacle keys its edition route on the edition id, not `external_id`
 * (see momentCanonicalPath) — pass `collectionUrlSlug = "disney-pinnacle"`
 * and the id is used. Without an external_id the only honest target is the
 * resolver URL, which redirects; that is the fallback, not the default.
 */
export function editionHref(
  collectionUrlSlug: string,
  externalId: string | null | undefined,
  editionId: string,
): string {
  if (collectionUrlSlug === "disney-pinnacle") return `/disney-pinnacle/edition/${encodeURIComponent(editionId)}`
  const ext = externalId?.trim()
  return ext ? `/${collectionUrlSlug}/edition/${encodeURIComponent(ext)}` : `/moment/${encodeURIComponent(editionId)}`
}

export function momentSubjectName(
  playerName: string | null | undefined,
  teamName: string | null | undefined,
  setName?: string | null,
): string {
  const p = playerName?.trim()
  if (p) return p
  const t = teamName?.trim()
  if (t) return t
  const s = setName?.trim()
  if (s) return s
  return "—"
}
