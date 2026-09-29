import { isPinnacleUrlSlug } from "@/lib/collection-slug"
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
 * The rule is entirely local (see isTeamMoment), so no extra data is needed anywhere this is called.
 */
export function momentSubjectHref(
  collectionUrlSlug: string,
  playerName: string | null | undefined,
  teamName: string | null | undefined,
): string | null {
  if (!playerName) return null
  const teamMoment = isTeamMoment(playerName, teamName)
  const kind = teamMoment ? "team" : "player"
  // A team Moment links to its FRANCHISE page, keyed on team_name: All Day's "Denver" is /team/denver-broncos.
  const slug = teamMoment ? slugifyName((teamName as string).trim()) : slugifyPlayerName(playerName)
  return `/${collectionUrlSlug}/${kind}/${encodeURIComponent(slug)}`
}

/**
 * Is this Moment's "who" a TEAM rather than a person? Two conventions, both with no `players` row:
 *   · Top Shot: `player_name === team_name` ("Sacramento Kings" / "Sacramento Kings").
 *   · All Day Team Melt: `player_name` is the franchise's CITY, `team_name` the franchise
 *     ("Denver" / "Denver Broncos"). 14 names, 2026-09-29; every one 404'd as /player/<city>.
 * The city rule is `team_name` starting with `player_name + " "`. Measured 2026-09-29: zero names
 * that DO have a players row match it in any collection, so no real player is rerouted.
 * lib/sitemap-data.ts uses this same predicate — one rule, so the links and the sitemap cannot drift.
 */
export function isTeamMoment(playerName: string | null | undefined, teamName: string | null | undefined): boolean {
  const p = playerName?.trim()
  const t = teamName?.trim()
  if (!p || !t) return false
  return p === t || t.startsWith(p + " ")
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
  if (isPinnacleUrlSlug(collectionUrlSlug)) return pinnacleRenderHref(editionId)
  const ext = externalId?.trim()
  return ext ? `/${collectionUrlSlug}/edition/${encodeURIComponent(ext)}` : `/moment/${encodeURIComponent(editionId)}`
}

/**
 * The edition-page href for a row that carries its ROUTE slug (the key the
 * `/[collection]/edition/[slug]` page resolves). On Disney Pinnacle that page
 * permanentRedirects EVERY slug to `/pinnacle/moment/<slug>` — and it can only
 * do so after the stream has started, so the reader gets a 200 placeholder and a
 * client-side hop, and the crawler a contentless 200 (live sweep 2026-09-27).
 * Link to the target directly; every other collection is unchanged.
 */
export function editionRouteHref(collectionUrlSlug: string, routeSlug: string): string {
  if (isPinnacleUrlSlug(collectionUrlSlug)) return pinnacleRenderHref(routeSlug)
  return `/${collectionUrlSlug}/edition/${encodeURIComponent(routeSlug)}`
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

/**
 * The canonical page for one Disney Pinnacle render.
 *
 * ⚠ `/disney-pinnacle/edition/<render_id>` is NOT it — that route
 * `permanentRedirect`s here (app/(collections)/[collection]/edition/[slug]/page.tsx),
 * so an internal link built with `editionHref` costs the reader a hop and hands
 * the crawler a duplicate URL. The sitemap already publishes this spelling
 * (lib/sitemap-data.ts), which is what makes it the canonical one.
 */
export function pinnacleRenderHref(renderId: string): string {
  return `/pinnacle/moment/${encodeURIComponent(renderId)}`
}

/** A Pinnacle franchise as get_team_detail keys it: ™ / ® / © removed ("Star Wars™" → "Star Wars"). */
export function pinnacleFranchiseName(name: string): string {
  return name.replace(/[\u2122\u00AE\u00A9]/g, "").trim()
}

/**
 * A Disney Pinnacle pin's entity links — its characters (the `characters`
 * TRAIT; `character_name` is the PIN's name and often has no page), franchises,
 * set and series. The pin page showed all of these as plain text (live sweep
 * 2026-09-27), where every other collection's detail page links them.
 */
export function pinnacleCharacterHref(name: string): string {
  return `/disney-pinnacle/player/${encodeURIComponent(slugifyName(name.trim()))}`
}
export function pinnacleFranchiseHref(name: string): string {
  return `/disney-pinnacle/team/${encodeURIComponent(slugifyName(pinnacleFranchiseName(name)))}`
}
export function pinnacleSeriesHref(seriesName: string): string {
  return `/disney-pinnacle/series/${encodeURIComponent(slugifyName(seriesName.trim()))}`
}

/**
 * The set-detail page for a set NAME, or `null` when this collection has none.
 *
 * 🚨 RETURNING `null` IS THE POINT. `/[collection]/set/[slug]` renders from
 * `get_set_detail(collection_id, set_slug)`, which reads `sets` + `editions`.
 * Measured live 2026-09-20: Disney Pinnacle has **0 rows in both** — it is
 * catalogued render-keyed in `pinnacle_catalog` instead — and the RPC returns
 * NULL for every Pinnacle slug, so the page 404s. Building the href anyway is
 * how the 54 dead Market links shipped (see
 * `collection-registry-consistency.test.ts`): a link that is *formed* correctly
 * and *resolves* to nothing. The caller renders plain text instead.
 *
 * ✅ PINNACLE RESOLVES SINCE 2026-09-26 (migration
 * `audit_20260926_pinnacle_catalog_only_sets_and_editions_reach_the_set_pages`):
 * `sets_summary` gained a Pinnacle arm from `pinnacle_catalog`, and
 * get_set_detail / get_set_editions read the catalog for it. Measured
 * 2026-09-27: 177 of 178 catalog set names resolve with this slug; the one miss
 * was a set first seen that afternoon, after the daily 07:50 UTC sets_summary
 * refresh — the same < 24 h lag every collection's new set has. So Pinnacle
 * gets a link like everyone else (a live sweep found its set names as plain
 * text on every pin page and table).
 *
 * ⛔ Do NOT "fix" this by seeding `sets`/`editions` for Pinnacle — its FMV,
 * pricing and every public surface key on `render_id`, and CLAUDE.md records
 * that separation as deliberate, not as debt.
 */
export function setEntityHref(
  collectionUrlSlug: string,
  setName: string | null | undefined,
): string | null {
  const name = setName?.trim()
  if (!name) return null
  return `/${collectionUrlSlug}/set/${encodeURIComponent(slugifyName(name))}`
}
