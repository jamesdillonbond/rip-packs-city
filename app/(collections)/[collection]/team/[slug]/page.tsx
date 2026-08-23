// app/(collections)/[collection]/team/[slug]/page.tsx
// Phase 1E. Team (or Franchise on Pinnacle) detail page.
//
// Data: get_team_detail(collection_id, team_slug) +
// get_team_players(collection_id, team_slug, 100, 0).
// UFC has no teams — get_team_detail returns null and the page calls notFound().

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { fetchEntityDetailRaw } from "@/lib/entity-detail-gate"
import { sectionRow, sectionRows, sectionRowsResult } from "@/lib/entity-section-rpc"
import { isExhibitionTeamSlug } from "@/lib/team-denylist"
import { teamPageMetadata, teamJsonLd, collectionDisplayName, NOT_FOUND_METADATA } from "@/lib/seo"
import { getEntityLabels } from "@/lib/entity-labels"
import { Section, StatCell, fmtCount, fmtUsd } from "@/components/entity/_shared"
import PlayersGridPaginated, { type PlayerTile } from "@/components/entity/PlayersGridPaginated"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import HeroMontage from "@/components/entity/HeroMontage"
import TeamHero, { type TeamNextGame } from "@/components/entity/TeamHero"
import TeamChecklist from "@/components/entity/TeamChecklist"
import TeamActivity, { type ActivityRow } from "@/components/entity/TeamActivity"
import TeamSets, { type SetRow } from "@/components/entity/TeamSets"
import TeamSqueeze, { type SqueezeRow } from "@/components/entity/TeamSqueeze"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ collection: string; slug: string }>
}

interface TeamDetail {
  team_slug: string
  team_name: string
  team_name_variants: string[] | null
  is_franchise: boolean | null
  player_count: number | null
  edition_count: number | null
  total_circulation: number | null
  fmv_total_usd: number | null
  floor_total_usd: number | null
  // Team Hub Phase 1 (D1): branding + 30d activity. Null on Pinnacle / unbranded teams.
  primary_color?: string | null
  secondary_color?: string | null
  abbreviation?: string | null
  team_external_id?: string | null
  league?: string | null
  sales_30d?: number | null
  volume_30d_usd?: number | string | null
  // Team Hub Phase 4 (F1a): teams_master short slug — the follow-write key.
  team_short_slug?: string | null
}

const PAGE_SIZE = 100

async function fetchDetail(collectionId: string, slug: string): Promise<TeamDetail | null> {
  // rpcWithRetry (inside fetchEntityDetailRaw): retry connection-class errors
  // (incl. pool-acquire timeouts) in-process before surfacing, so a transient
  // blip no longer throws to the error boundary / Sentry on the first miss.
  // cache()'d, so the segment layout's 404 gate + generateMetadata + this render
  // share ONE get_team_detail call. See lib/entity-detail-gate.ts.
  const { data, error } = await fetchEntityDetailRaw("team", collectionId, slug)
  if (error) {
    // A transient RPC failure (statement timeout under contention) must NOT
    // render as "team not found" — that soft-404s real franchise pages.
    // Throw so the error boundary shows a retryable state instead.
    console.error("[team] detail error", error.message)
    throw new Error(`team detail unavailable: ${error.message}`)
  }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as TeamDetail) ?? null
  return data as TeamDetail
}

// Section fetches go through lib/entity-section-rpc.ts: connection-class errors
// (the pool-acquire timeouts this page's six-way Promise.all fan-out produces)
// retry before surfacing, and the ROSTER is structural — if it fails after
// retries we throw a retryable error rather than render a real franchise with a
// convincingly empty roster. The rest degrade to empty and log under
// `[entity-section]` so the degradation is greppable.
async function fetchPlayers(collectionId: string, slug: string, limit: number, offset: number): Promise<PlayerTile[]> {
  return sectionRows<PlayerTile>("team roster", "get_team_players", { p_collection_id: collectionId, p_team_slug: slug, p_limit: limit, p_offset: offset }, { structural: true })
}

async function fetchTopEditions(collectionId: string, slug: string, limit: number, offset: number): Promise<EditionTile[]> {
  return sectionRows<EditionTile>("team top editions", "get_team_top_editions", { p_collection_id: collectionId, p_team_slug: slug, p_limit: limit, p_offset: offset })
}

// Three-state, because TeamActivity's empty copy CONCLUDES ("No recent sales.").
// A decorative section degrading to [] would otherwise publish that sentence out
// of a failed read — this team page's six-way RPC fan-out is exactly what
// produces the pool-acquire timeouts that trigger it.
async function fetchActivity(collectionId: string, slug: string, limit: number): Promise<{ rows: ActivityRow[]; ok: boolean }> {
  return sectionRowsResult<ActivityRow>("team activity", "get_team_activity", { p_collection_id: collectionId, p_team_slug: slug, p_limit: limit, p_offset: 0 })
}

async function fetchSets(collectionId: string, slug: string): Promise<SetRow[]> {
  return sectionRows<SetRow>("team sets", "get_team_sets", { p_collection_id: collectionId, p_team_slug: slug, p_wallet: null })
}

async function fetchSqueeze(collectionId: string, slug: string, limit: number): Promise<SqueezeRow[]> {
  return sectionRows<SqueezeRow>("team squeeze", "get_team_squeeze", { p_collection_id: collectionId, p_team_slug: slug, p_limit: limit })
}

async function fetchNextGame(collectionId: string, slug: string): Promise<TeamNextGame | null> {
  return sectionRow<TeamNextGame>("team next game", "get_team_next_game", { p_collection_id: collectionId, p_team_slug: slug })
}

const TOP_EDITIONS_PAGE_SIZE = 24

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ collection: string; slug: string }> }): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return NOT_FOUND_METADATA
  // Exhibition / all-star rosters are not real franchises — no hub page.
  if (isExhibitionTeamSlug(slug)) return NOT_FOUND_METADATA
  let detail: TeamDetail | null = null
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    // Transient detail failure: emit a generic (non-404) title so crawlers
    // never cache a not-found signal for a real team.
    return { title: `${slug.replace(/-/g, " ")} | ${coll.displayName} | Rip Packs City` }
  }
  if (!detail) return NOT_FOUND_METADATA
  return teamPageMetadata(detail as unknown as Record<string, unknown>, collection, slug)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function TeamPage(props: { params: Promise<{ collection: string; slug: string }> }) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()
  // Exhibition / all-star rosters are not real franchises — 404 the junk pages
  // that are already indexed (Team LeBron, Rising Stars, …).
  if (isExhibitionTeamSlug(slug)) notFound()

  // ⚠ BOUNDED READ (deep-audit R19) — same shape as the set page.
  // Observed live: /nba-top-shot/team/los-angeles-lakers served a bare
  // "500: This page couldn't load" under DB load. An error.tsx boundary does NOT
  // catch it: this route is ISR, so the throw happens during GENERATION, not
  // while a mounted tree renders, and Next serves its own default error page.
  //
  // ⚠ A FAILED READ MUST NOT BECOME notFound(). `!detail` means the RPC answered
  // and this team does not exist. A THROW means we could not ask — 404-ing there
  // tells a crawler a real franchise page is gone.
  let detail: Awaited<ReturnType<typeof fetchDetail>> = null
  let detailFailed = false
  try {
    detail = await fetchDetail(coll.id, slug)
  } catch {
    detailFailed = true
  }
  if (detailFailed) return <TeamUnavailable collection={collection} slug={slug} />
  if (!detail) notFound()

  const labels = getEntityLabels(collection)
  const isFranchise = detail.is_franchise === true
  const noun = isFranchise ? labels.team /* Franchise */ : labels.team /* Team */
  const rosterLabel = labels.roster

  const [players, topEditions, activityRes, teamSets, squeeze, nextGame] = await Promise.all([
    fetchPlayers(coll.id, slug, PAGE_SIZE, 0),
    fetchTopEditions(coll.id, slug, TOP_EDITIONS_PAGE_SIZE, 0),
    fetchActivity(coll.id, slug, 40),
    fetchSets(coll.id, slug),
    fetchSqueeze(coll.id, slug, 12),
    fetchNextGame(coll.id, slug),
  ])
  const activity = activityRes.rows

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(teamJsonLd(detail as unknown as Record<string, unknown>, collection, slug)) }}
      />
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: collectionDisplayName(collection), href: `/${collection}` },
          { name: detail.team_name },
        ]}
      />
      {/* ── Hero (branded when in teams_master, else plain text) ─────────────── */}
      <TeamHero
        teamName={detail.team_name}
        noun={noun}
        abbreviation={detail.abbreviation}
        primaryColor={detail.primary_color}
        secondaryColor={detail.secondary_color}
        leagueLabel={detail.league}
        externalId={detail.team_external_id}
        isFranchise={isFranchise}
        nextGame={nextGame}
        followLeague={detail.league}
        followShortSlug={detail.team_short_slug}
        teamPath={`/${collection}/team/${slug}`}
      />
      {detail.team_name_variants && detail.team_name_variants.length > 1 && (
        <div className="rpc-mono" style={{ marginTop: 8, fontSize: 11, color: "var(--rpc-text-muted)" }}>
          Variants merged: {detail.team_name_variants.join(" · ")}
        </div>
      )}
      {topEditions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <HeroMontage items={topEditions} collectionUrlSlug={collection} />
        </div>
      )}

      {/* ── Stat strip ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <StatCell label={isFranchise ? "Characters" : "Players"} value={fmtCount(detail.player_count)} />
        <StatCell label="Editions" value={fmtCount(detail.edition_count)} />
        <StatCell label="Total Mint" value={fmtCount(detail.total_circulation)} />
        <StatCell label="FMV Total" value={fmtUsd(detail.fmv_total_usd)} />
        <StatCell label="Floor Total" value={fmtUsd(detail.floor_total_usd)} />
        <StatCell label="30d Sales" value={fmtCount(detail.sales_30d)} />
        <StatCell label="30d Volume" value={fmtUsd(detail.volume_30d_usd == null ? null : Number(detail.volume_30d_usd))} />
      </section>

      {/* ── Team Checklist (headline feature) ────────────────────────────── */}
      <Section title="Team Checklist">
        <TeamChecklist collectionUrlSlug={collection} teamSlug={slug} />
      </Section>

      {/* ── Top Editions ─────────────────────────────────────────────────── */}
      {topEditions.length > 0 && (
        <Section title="Top Editions">
          <EditionsGridPaginated
            collectionUrlSlug={collection}
            fetchUrl={`/api/entity/team-editions?collection=${encodeURIComponent(collection)}&slug=${encodeURIComponent(slug)}`}
            initial={topEditions}
            pageSize={TOP_EDITIONS_PAGE_SIZE}
            showSetLink
            showSort
          />
        </Section>
      )}

      {/* ── Market Activity ──────────────────────────────────────────────── */}
      {activity.length > 0 && (
        <Section title="Market Activity">
          <TeamActivity collectionUrlSlug={collection} rows={activity} ok={activityRes.ok} />
        </Section>
      )}

      {/* ── Sets featuring the team ──────────────────────────────────────── */}
      {teamSets.length > 0 && (
        <Section title={`Sets featuring ${detail.team_name}`}>
          <TeamSets collectionUrlSlug={collection} teamSlug={slug} initial={teamSets} />
        </Section>
      )}

      {/* ── Squeeze & Scarcity (Top Shot only; self-hides when empty) ─────── */}
      {squeeze.length > 0 && (
        <Section title="Squeeze & Scarcity">
          <TeamSqueeze collectionUrlSlug={collection} rows={squeeze} />
        </Section>
      )}

      {/* ── Roster / Cast grid ───────────────────────────────────────────── */}
      <Section title={rosterLabel}>
        <PlayersGridPaginated
          collectionUrlSlug={collection}
          fetchUrl={`/api/entity/team?collection=${encodeURIComponent(collection)}&slug=${encodeURIComponent(slug)}`}
          initial={players}
          pageSize={PAGE_SIZE}
          isFranchise={isFranchise}
        />
      </Section>
    </div>
  )
}

// Rendered when get_team_detail could not be READ — distinct from a team that
// does not exist (that still 404s). Reports our failure and makes no claim about
// the team's holdings.
function TeamUnavailable({ collection, slug }: { collection: string; slug: string }) {
  const name = slug.replace(/-/g, " ")
  return (
    <main style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Team unavailable
      </div>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "clamp(28px, 5vw, 44px)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0, textAlign: "center" }}>
        Couldn&rsquo;t load {name}
      </h1>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
        The team data didn&rsquo;t come back in time, so nothing is shown rather than a partial view.
        This is a problem on our side &mdash; it does not mean the team has no moments. Reloading often works.
      </p>
      <a
        href={`/${collection}/overview`}
        style={{ marginTop: 8, padding: "10px 18px", border: "1px solid var(--rpc-red-border)", color: "var(--rpc-red)", background: "transparent", fontFamily: "var(--font-mono)", letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 12, textDecoration: "none" }}
      >
        Back to overview
      </a>
    </main>
  )
}
