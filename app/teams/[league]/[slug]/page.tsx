// app/teams/[league]/[slug]/page.tsx
//
// Franchise hub (2026-09-23): one page per real-world team, gathering every
// collection that carries it. /teams/nba/blazers, /teams/mlb/tigers.
//
// Registry: teams_master + league_collections via get_franchise_hub. Panels:
// the SAME get_team_detail the per-collection team page reads, so the hub and
// the page it links to cannot disagree. Data layer: lib/franchise-hub.ts.
//
// ⚠ Today every league maps to ONE enabled collection, so a hub shows one
// panel. The second arrives when Panini NBA/MLB clears the accuracy gate and
// its league_collections row is enabled — a DATA change, no deploy. Until a
// hub gathers 2+ collections it is noindex (see hubIsIndexable).
//
// ⚠ A FAILED READ MUST NOT BECOME notFound() — only a clean NULL from
// get_franchise_hub 404s. And a failed PANEL renders as unavailable, never as
// "no cards" (three states, lib/franchise-hub.ts).

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { isExhibitionTeamSlug } from "@/lib/team-denylist"
import { NOT_FOUND_METADATA } from "@/lib/seo"
import { LEAGUES } from "@/lib/teams"
import {
  fetchFranchiseHub,
  fetchHubPanels,
  franchiseHubPath,
  hubIsIndexable,
  parseHubParams,
  type FranchiseHub,
  type HubPanel,
} from "@/lib/franchise-hub"
import { Section, SectionUnavailable, StatCell, fmtCount, fmtUsd } from "@/components/entity/_shared"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import TeamHero from "@/components/entity/TeamHero"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ league: string; slug: string }>
}

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

function leagueLabel(league: string): string {
  return LEAGUES.find((l) => l.value === league)?.label ?? league
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ league: string; slug: string }> }): Promise<Metadata> {
  const { league: rawLeague, slug: rawSlug } = await props.params
  const key = parseHubParams(rawLeague, rawSlug)
  if (!key) return NOT_FOUND_METADATA
  const { hub, ok } = await fetchFranchiseHub(key.league, key.slug)
  if (!ok) {
    // Could not ask: a generic, non-404 title so crawlers never cache a
    // not-found signal for a real franchise.
    return { title: { absolute: "Team Hub | Rip Packs City" }, robots: { index: false, follow: true } }
  }
  if (!hub) return NOT_FOUND_METADATA
  const canonical = `${SITE}${franchiseHubPath(hub.league, hub.team_slug)}`
  return {
    title: { absolute: `${hub.team_name} Collectibles Hub | ${leagueLabel(hub.league)} | Rip Packs City` },
    description: `Every ${hub.team_name} digital collectible Rip Packs City tracks, gathered in one place — editions, fair market value and 30-day market activity per collection.`,
    alternates: { canonical },
    robots: hubIsIndexable(hub) ? { index: true, follow: true } : { index: false, follow: true },
  }
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function FranchiseHubPage(props: { params: Promise<{ league: string; slug: string }> }) {
  const { league: rawLeague, slug: rawSlug } = await props.params
  const key = parseHubParams(rawLeague, rawSlug)
  if (!key) notFound()

  const { hub, ok } = await fetchFranchiseHub(key.league, key.slug)
  if (!ok) return <HubUnavailable />
  if (!hub) notFound()

  const panels = await fetchHubPanels(hub)
  const hubPath = franchiseHubPath(hub.league, hub.team_slug)

  return (
    <div>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: hub.team_name }]} />
      <TeamHero
        teamName={hub.team_name}
        noun="Team"
        abbreviation={hub.abbreviation}
        primaryColor={hub.primary_color}
        secondaryColor={hub.secondary_color}
        leagueLabel={hub.league}
        externalId={hub.external_id}
        isFranchise={false}
        followLeague={hub.league}
        followShortSlug={hub.team_slug}
        teamPath={hubPath}
      />

      <Section title={`${hub.team_name} across collections`}>
        {panels.length === 0 ? (
          // Every mapped collection is one the app cannot route to. That is a
          // registry gap, not a catalogue fact — say what we know.
          <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
            No collection pages are available for this team yet.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 14 }}>
            {panels.map((p) => (
              <CollectionPanel key={p.collection.id} panel={p} hub={hub} />
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function CollectionPanel({ panel, hub }: { panel: HubPanel; hub: FranchiseHub }) {
  const name = panel.collection.displayName
  const teamHref = isExhibitionTeamSlug(hub.route_slug)
    ? null
    : `/${panel.collection.urlSlug}/team/${encodeURIComponent(hub.route_slug)}`

  return (
    <div className="rpc-card" style={{ padding: 16, borderTop: `3px solid ${hub.secondary_color || "var(--rpc-red)"}` }}>
      <div
        className="rpc-mono"
        style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 12 }}
      >
        {name}
      </div>

      {panel.state === "failed" && <SectionUnavailable noun={`${hub.team_name} on ${name}`} />}

      {panel.state === "empty" && (
        // The read ANSWERED with no team detail — a measured absence, not a timeout.
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
          No {name} editions for {hub.team_name} in our catalogue.
        </div>
      )}

      {panel.state === "ok" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
            <StatCell label="Editions" value={fmtCount(panel.detail.edition_count)} />
            <StatCell label="Players" value={fmtCount(panel.detail.player_count)} />
            <StatCell label="FMV Total" value={fmtUsd(num(panel.detail.fmv_total_usd))} />
            <StatCell label="30d Sales" value={fmtCount(panel.detail.sales_30d)} />
            <StatCell label="30d Volume" value={fmtUsd(num(panel.detail.volume_30d_usd))} />
          </div>
          {teamHref && (
            <Link
              href={teamHref}
              className="rpc-mono"
              style={{ display: "inline-block", marginTop: 14, fontSize: 12, color: "var(--rpc-red)", letterSpacing: "0.04em", textDecoration: "none" }}
            >
              Open {hub.team_name} on {name} →
            </Link>
          )}
        </>
      )}
    </div>
  )
}

// Rendered when get_franchise_hub could not be READ — distinct from a team that
// does not exist (that 404s). Makes no claim about the team.
function HubUnavailable() {
  return (
    <main style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Team hub unavailable
      </div>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
        The team data didn&rsquo;t come back in time. This is a problem on our side &mdash; it says nothing about the team. Reloading often works.
      </p>
    </main>
  )
}
