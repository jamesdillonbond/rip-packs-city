// app/players/[slug]/page.tsx
//
// Player hub (2026-10-22): one page per player name, gathering every collection
// that carries it. /players/damian-lillard = his NBA Top Shot Moments and his
// Panini cards. The search bar's player rows link here.
//
// Registry: get_player_hub (lib/player-hub.ts). Panels: the SAME
// get_player_detail / get_player_editions the per-collection player page reads,
// so the hub and the page it links to cannot disagree.
//
// ⚠ A NAME IS NOT A PERSON. Collections are matched by name and GROUPED BY
// SPORT; when a name spans two sports the page says these are different people
// rather than adding them up. /players/larry-johnson is the point.
//
// ⚠ A FAILED READ MUST NOT BECOME notFound() — only a clean NULL 404s. A failed
// PANEL renders as unavailable, never as "no editions".
//
// A name only one collection carries has nothing to gather: the hub redirects
// to that collection's player page (307 — the next mint can make it a hub).

import type { Metadata } from "next"
import { cache, type ReactNode } from "react"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { NOT_FOUND_METADATA, playerHubMetadata } from "@/lib/seo"
import {
  PLAYER_HUB_TOP_EDITIONS,
  fetchPlayerHub,
  fetchPlayerHubEditions,
  fetchPlayerHubPanels,
  groupBySport,
  parsePlayerHubSlug,
  playerHubIsIndexable,
  playerHubPath,
  routableEntries,
  type PlayerHub,
  type PlayerHubPanel,
} from "@/lib/player-hub"
import { proxyIpfsImageUrl } from "@/lib/ipfs-media"
import { Section, SectionUnavailable, StatCell, RECENT_LOW_TOTAL_LABEL, fmvTotalSub, fmtCount, fmtUsd } from "@/components/entity/_shared"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ slug: string }>
}

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ONE hub read per request, shared by generateMetadata and the body (the
// franchise hub's 09-25 lesson: two reads can cache a split outcome).
const fetchPlayerHubOnce = cache((slug: string) => fetchPlayerHub(slug))

function collectionsPhrase(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1]
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug: rawSlug } = await props.params
  const slug = parsePlayerHubSlug(rawSlug)
  if (!slug) return NOT_FOUND_METADATA
  const { hub, ok } = await fetchPlayerHubOnce(slug)
  if (!ok) {
    // Could not ask: a generic, non-404 title so crawlers never cache a
    // not-found signal for a real player.
    return { title: { absolute: "Player Hub | Rip Packs City" }, robots: { index: false, follow: true } }
  }
  if (!hub) return NOT_FOUND_METADATA
  const routable = routableEntries(hub)
  const names = routable.map((r) => r.collection.displayName)
  // 2026-10-27: a name spanning sports is more than one athlete — the snippet must not present them as one person.
  const sports = groupBySport(routable.map((r) => r.entry))
  const description = sports.length > 1
    ? `Digital collectibles of every athlete named ${hub.name} that Rip Packs City tracks, grouped by sport (${sports.map((g) => g.label).join(", ")}) — ${collectionsPhrase(names)}: editions and fair market value per collection.`
    : `Every ${hub.name} digital collectible Rip Packs City tracks, gathered in one place — ${collectionsPhrase(names)}: editions and fair market value per collection.`
  return {
    ...playerHubMetadata({
      name: `${hub.name} Digital Collectibles`,
      description,
      canonical: `${SITE}${playerHubPath(hub.canonical_slug)}`,
    }),
    robots: playerHubIsIndexable(hub) ? { index: true, follow: true } : { index: false, follow: true },
  }
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function PlayerHubPage(props: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await props.params
  const slug = parsePlayerHubSlug(rawSlug)
  if (!slug) notFound()

  const { hub, ok } = await fetchPlayerHubOnce(slug)
  if (!ok) return <HubUnavailable />
  if (!hub) notFound()

  const routable = routableEntries(hub)
  if (routable.length === 0) notFound()
  if (routable.length === 1) {
    const only = routable[0]
    redirect(`/${only.collection.urlSlug}/player/${encodeURIComponent(only.entry.player_slug)}`)
  }

  const panels = await fetchPlayerHubPanels(hub)
  const editions = await fetchPlayerHubEditions(panels)
  const panelById = new Map(panels.map((p) => [p.collection.id, p]))
  const groups = groupBySport(routable.map((r) => r.entry))
  const manyPeople = groups.length > 1
  const totalEditions = routable.reduce((n, r) => n + (Number(r.entry.edition_count) || 0), 0)

  // Portrait: a collection headshot, else the first edition art we loaded.
  const firstArt = [...editions.values()].flatMap((e) => e.rows as EditionTile[]).find((t) => t?.thumbnail_url)?.thumbnail_url
  const portrait = routable.find((r) => r.entry.headshot_url)?.entry.headshot_url ?? proxyIpfsImageUrl(firstArt, 640) ?? null

  return (
    <div>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: hub.name }]} />

      <section className="rpc-card" style={{ padding: 18 }}>
        <div className="rpc-entity-hero rpc-entity-hero--240">
          <div style={{ width: "100%", maxWidth: 240, aspectRatio: "1 / 1", background: "rgba(0,0,0,0.4)", border: "1px solid var(--rpc-border)", borderRadius: 6, overflow: "hidden" }}>
            {portrait ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={portrait} alt={`${hub.name} portrait`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", background: "var(--rpc-surface)", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                No portrait
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.18em", textTransform: "uppercase" }}>
              Player · Every collection
            </div>
            <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
              {hub.name}
            </h1>
            <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em" }}>
              {/* 2026-10-27: one total only when every collection is one athlete's sport — with more than one
                  athlete it summed two people ("20 editions across NBA Top Shot, NFL All Day and Panini" for a
                  basketball and a football Larry Johnson), contradicting the line below. */}
              {manyPeople
                ? groups
                    .map((g) => {
                      const ids = new Set(g.entries.map((e) => e.collection_id))
                      const inGroup = routable.filter((r) => ids.has(r.entry.collection_id))
                      const n = inGroup.reduce((sum, r) => sum + (Number(r.entry.edition_count) || 0), 0)
                      return `${g.label}: ${fmtCount(n)} editions across ${collectionsPhrase(inGroup.map((r) => r.collection.displayName))}`
                    })
                    .join(" · ")
                : `${fmtCount(totalEditions)} editions across ${collectionsPhrase(routable.map((r) => r.collection.displayName))}`}
            </div>
            <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
              {manyPeople
                ? `More than one athlete carries this name. Collections are matched by name and grouped by sport — ${groups.map((g) => g.label).join(", ")} — and each group is shown separately, never added together.`
                : "Collections are matched by player name. Each panel is that collection's own numbers."}
            </div>
          </div>
        </div>
      </section>

      {groups.map((g) => (
        <Section key={g.sport} title={manyPeople ? `${hub.name} · ${g.label}` : `${hub.name} across collections`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 14 }}>
            {g.entries.map((entry) => {
              const p = panelById.get(entry.collection_id)
              return p ? <CollectionPanel key={entry.collection_id} panel={p} hub={hub} editions={editions.get(entry.collection_id) ?? null} /> : null
            })}
          </div>
        </Section>
      ))}
    </div>
  )
}

function CollectionPanel({ panel, hub, editions }: { panel: PlayerHubPanel; hub: PlayerHub; editions: { rows: unknown[]; ok: boolean } | null }) {
  const name = panel.collection.displayName
  const isPanini = panel.collection.dbSlug === "panini_blockchain"
  const playerHref = `/${panel.collection.urlSlug}/player/${encodeURIComponent(panel.entry.player_slug)}`
  // The collection's own spelling, when it differs ("Steph Curry" on Top Shot).
  const spelledAs = panel.entry.name && panel.entry.name !== hub.name ? panel.entry.name : null

  return (
    <div className="rpc-card" style={{ padding: 16, borderTop: "3px solid var(--rpc-red)" }}>
      <div className="rpc-mono" style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 12 }}>
        {name}
        {spelledAs && <span style={{ letterSpacing: "0.04em", textTransform: "none" }}> · as {spelledAs}</span>}
      </div>

      {panel.state === "failed" && <SectionUnavailable noun={`${hub.name} on ${name}`} />}

      {panel.state === "empty" && (
        // The detail read ANSWERED with nothing — a measured absence, not a timeout.
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
          No {name} page for {panel.entry.name} right now.
        </div>
      )}

      {panel.state === "ok" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
            <StatCell label="Editions" value={fmtCount(panel.detail.edition_count)} />
            <StatCell label="Total Mint" value={fmtCount(panel.detail.total_circulation)} />
            <StatCell label="FMV Total" value={fmtUsd(num(panel.detail.fmv_total_usd))} sub={fmvTotalSub(panel.detail)} />
            {/* Panini has no floor source: its floor total is the FMV total restated
                (same exclusion as the per-collection player page). */}
            {!isPanini && <StatCell label={RECENT_LOW_TOTAL_LABEL} value={fmtUsd(num(panel.detail.floor_total_usd))} />}
          </div>

          {/* Editions — three-state: unavailable / measured absence (omitted) / grid. */}
          {editions && (editions.rows.length > 0 || !editions.ok) && (
            <div style={{ marginTop: 16 }}>
              <PanelLabel>Editions</PanelLabel>
              {!editions.ok ? (
                <SectionUnavailable noun={`${hub.name}’s ${name} editions`} />
              ) : (
                <EditionsGridPaginated
                  collectionUrlSlug={panel.collection.urlSlug}
                  fetchUrl={`/api/entity/player?collection=${encodeURIComponent(panel.collection.urlSlug)}&slug=${encodeURIComponent(panel.entry.player_slug)}`}
                  initial={editions.rows as EditionTile[]}
                  initialFailed={false}
                  pageSize={PLAYER_HUB_TOP_EDITIONS}
                  showSetLink
                />
              )}
            </div>
          )}
        </>
      )}

      <Link
        href={playerHref}
        className="rpc-mono"
        style={{ display: "inline-block", marginTop: 14, fontSize: 12, color: "var(--rpc-red-text)", letterSpacing: "0.04em", textDecoration: "none" }}
      >
        Open {panel.entry.name} on {name} →
      </Link>
    </div>
  )
}

function PanelLabel({ children }: { children: ReactNode }) {
  return (
    <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 8 }}>
      {children}
    </div>
  )
}

// Rendered when get_player_hub could not be READ — distinct from a name no
// collection carries (that 404s). Makes no claim about the player.
function HubUnavailable() {
  return (
    // A <div>, not a <main>: app/players/layout.tsx supplies the page's <main>.
    <div style={{ minHeight: "60vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", gap: 16 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Player hub unavailable
      </div>
      <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 520, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
        The player data didn&rsquo;t come back in time. This is a problem on our side &mdash; it says nothing about the player. Reloading often works.
      </p>
    </div>
  )
}
