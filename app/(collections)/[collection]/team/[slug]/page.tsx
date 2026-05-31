// app/(collections)/[collection]/team/[slug]/page.tsx
// Phase 1E. Team (or Franchise on Pinnacle) detail page.
//
// Data: get_team_detail(collection_id, team_slug) +
// get_team_players(collection_id, team_slug, 100, 0).
// UFC has no teams — get_team_detail returns null and the page calls notFound().

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { teamPageMetadata, teamJsonLd, collectionDisplayName } from "@/lib/seo"
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

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
function rpc() { return supabaseAdmin as unknown as RpcClient }

async function fetchDetail(collectionId: string, slug: string): Promise<TeamDetail | null> {
  const { data, error } = await rpc().rpc("get_team_detail", { p_collection_id: collectionId, p_team_slug: slug })
  if (error) { console.error("[team] detail error", error.message); return null }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as TeamDetail) ?? null
  return data as TeamDetail
}

async function fetchPlayers(collectionId: string, slug: string, limit: number, offset: number): Promise<PlayerTile[]> {
  const { data, error } = await rpc().rpc("get_team_players", { p_collection_id: collectionId, p_team_slug: slug, p_limit: limit, p_offset: offset })
  if (error) { console.error("[team] players error", error.message); return [] }
  return Array.isArray(data) ? (data as PlayerTile[]) : []
}

async function fetchTopEditions(collectionId: string, slug: string, limit: number, offset: number): Promise<EditionTile[]> {
  const { data, error } = await rpc().rpc("get_team_top_editions", { p_collection_id: collectionId, p_team_slug: slug, p_limit: limit, p_offset: offset })
  if (error) { console.error("[team] top editions error", error.message); return [] }
  return Array.isArray(data) ? (data as EditionTile[]) : []
}

async function fetchActivity(collectionId: string, slug: string, limit: number): Promise<ActivityRow[]> {
  const { data, error } = await rpc().rpc("get_team_activity", { p_collection_id: collectionId, p_team_slug: slug, p_limit: limit, p_offset: 0 })
  if (error) { console.error("[team] activity error", error.message); return [] }
  return Array.isArray(data) ? (data as ActivityRow[]) : []
}

async function fetchSets(collectionId: string, slug: string): Promise<SetRow[]> {
  const { data, error } = await rpc().rpc("get_team_sets", { p_collection_id: collectionId, p_team_slug: slug, p_wallet: null })
  if (error) { console.error("[team] sets error", error.message); return [] }
  return Array.isArray(data) ? (data as SetRow[]) : []
}

async function fetchSqueeze(collectionId: string, slug: string, limit: number): Promise<SqueezeRow[]> {
  const { data, error } = await rpc().rpc("get_team_squeeze", { p_collection_id: collectionId, p_team_slug: slug, p_limit: limit })
  if (error) { console.error("[team] squeeze error", error.message); return [] }
  return Array.isArray(data) ? (data as SqueezeRow[]) : []
}

async function fetchNextGame(collectionId: string, slug: string): Promise<TeamNextGame | null> {
  const { data, error } = await rpc().rpc("get_team_next_game", { p_collection_id: collectionId, p_team_slug: slug })
  if (error) { console.error("[team] next game error", error.message); return null }
  return (data && typeof data === "object" && !Array.isArray(data)) ? (data as TeamNextGame) : null
}

const TOP_EDITIONS_PAGE_SIZE = 24

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ collection: string; slug: string }> }): Promise<Metadata> {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  const detail = await fetchDetail(coll.id, slug)
  if (!detail) return {}
  return teamPageMetadata(detail as unknown as Record<string, unknown>, collection, slug)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function TeamPage(props: { params: Promise<{ collection: string; slug: string }> }) {
  const { collection, slug: rawSlug } = await props.params
  const slug = decodeURIComponent(rawSlug)
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  const detail = await fetchDetail(coll.id, slug)
  if (!detail) notFound()

  const labels = getEntityLabels(collection)
  const isFranchise = detail.is_franchise === true
  const noun = isFranchise ? labels.team /* Franchise */ : labels.team /* Team */
  const rosterLabel = labels.roster

  const [players, topEditions, activity, teamSets, squeeze, nextGame] = await Promise.all([
    fetchPlayers(coll.id, slug, PAGE_SIZE, 0),
    fetchTopEditions(coll.id, slug, TOP_EDITIONS_PAGE_SIZE, 0),
    fetchActivity(coll.id, slug, 40),
    fetchSets(coll.id, slug),
    fetchSqueeze(coll.id, slug, 12),
    fetchNextGame(coll.id, slug),
  ])

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
          <HeroMontage items={topEditions} />
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
          <TeamActivity collectionUrlSlug={collection} rows={activity} />
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
