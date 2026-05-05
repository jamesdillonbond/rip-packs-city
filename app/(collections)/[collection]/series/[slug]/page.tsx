// app/(collections)/[collection]/series/[slug]/page.tsx
// Phase 1F. Series detail page across all 5 published collections.
//
// Data: get_series_detail(collection_id, series_slug) +
// get_series_editions(collection_id, series_slug, 100, 0).
// Some series have edition_count = 0 (sparse coverage) — empty state.

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { seriesPageMetadata } from "@/lib/seo"
import { Section, StatCell, fmtCount, fmtUsd } from "@/components/entity/_shared"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ collection: string; slug: string }>
}

interface SeriesDetail {
  series_number: number | null
  display_label: string
  season: string | null
  edition_count: number | null
  total_circulation: number | null
  fmv_total_usd: number | null
  floor_total_usd: number | null
  set_count: number | null
  player_count: number | null
}

const PAGE_SIZE = 100

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
function rpc() { return supabaseAdmin as unknown as RpcClient }

async function fetchDetail(collectionId: string, slug: string): Promise<SeriesDetail | null> {
  const { data, error } = await rpc().rpc("get_series_detail", { p_collection_id: collectionId, p_series_slug: slug })
  if (error) { console.error("[series] detail error", error.message); return null }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as SeriesDetail) ?? null
  return data as SeriesDetail
}

async function fetchEditions(collectionId: string, slug: string, limit: number, offset: number): Promise<EditionTile[]> {
  const { data, error } = await rpc().rpc("get_series_editions", { p_collection_id: collectionId, p_series_slug: slug, p_limit: limit, p_offset: offset })
  if (error) { console.error("[series] editions error", error.message); return [] }
  return Array.isArray(data) ? (data as EditionTile[]) : []
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ collection: string; slug: string }> }): Promise<Metadata> {
  const { collection, slug } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  const detail = await fetchDetail(coll.id, slug)
  if (!detail) return {}
  return seriesPageMetadata(detail as unknown as Record<string, unknown>, collection, slug)
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function SeriesPage(props: { params: Promise<{ collection: string; slug: string }> }) {
  const { collection, slug } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  const detail = await fetchDetail(coll.id, slug)
  if (!detail) notFound()

  const isEmpty = (detail.edition_count ?? 0) === 0
  const editions = isEmpty ? [] : await fetchEditions(coll.id, slug, PAGE_SIZE, 0)

  // Top 25 = first 25 (RPC pre-sorts by FMV desc).
  const top25 = editions.slice(0, 25)

  // Sets in series — group by set_slug.
  const setMap = new Map<string, { setSlug: string; setName: string; count: number; fmvTotal: number }>()
  for (const e of editions) {
    if (!e.set_slug || !e.set_name) continue
    const existing = setMap.get(e.set_slug)
    if (existing) {
      existing.count += 1
      existing.fmvTotal += e.fmv_usd ?? 0
    } else {
      setMap.set(e.set_slug, { setSlug: e.set_slug, setName: e.set_name, count: 1, fmvTotal: e.fmv_usd ?? 0 })
    }
  }
  const setCards = Array.from(setMap.values()).sort((a, b) => b.fmvTotal - a.fmvTotal)

  // Top 12 players — group by player_slug.
  const playerMap = new Map<string, { playerSlug: string; playerName: string; count: number; fmvTotal: number }>()
  for (const e of editions) {
    const ps = e.player_slug ?? null
    const pn = e.player_name ?? null
    if (!ps || !pn) continue
    const existing = playerMap.get(ps)
    if (existing) {
      existing.count += 1
      existing.fmvTotal += e.fmv_usd ?? 0
    } else {
      playerMap.set(ps, { playerSlug: ps, playerName: pn, count: 1, fmvTotal: e.fmv_usd ?? 0 })
    }
  }
  const topPlayers = Array.from(playerMap.values()).sort((a, b) => b.fmvTotal - a.fmvTotal).slice(0, 12)

  return (
    <div>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="rpc-card" style={{ padding: 18 }}>
        <h1 style={{ margin: 0, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
          {detail.display_label}
        </h1>
        {detail.season && (
          <div className="rpc-mono" style={{ marginTop: 6, fontSize: 13, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em" }}>
            {detail.season}
          </div>
        )}
      </section>

      {/* ── Stat strip ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
        <StatCell label="Editions" value={fmtCount(detail.edition_count)} />
        <StatCell label="Sets" value={fmtCount(detail.set_count)} />
        <StatCell label="Players" value={fmtCount(detail.player_count)} />
        <StatCell label="FMV Total" value={fmtUsd(detail.fmv_total_usd)} />
        <StatCell label="Floor Total" value={fmtUsd(detail.floor_total_usd)} />
      </section>

      {isEmpty ? (
        <div className="rpc-card" style={{ marginTop: 14, padding: "22px 18px", textAlign: "center", color: "var(--rpc-text-muted)", fontFamily: "'Share Tech Mono', monospace", fontSize: 12 }}>
          No editions in this series yet
        </div>
      ) : (
        <>
          {/* ── Top 25 ────────────────────────────────────────────────────── */}
          <Section title="Top Editions">
            <EditionsGridPaginated
              collectionUrlSlug={collection}
              fetchUrl={`/api/entity/series?collection=${encodeURIComponent(collection)}&slug=${encodeURIComponent(slug)}`}
              initial={top25}
              pageSize={PAGE_SIZE}
              showSetLink
              showSort={false}
            />
          </Section>

          {/* ── Sets in this Series ──────────────────────────────────────── */}
          {setCards.length > 0 && (
            <Section title="Sets in this Series">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
                {setCards.map(s => (
                  <Link
                    key={s.setSlug}
                    href={`/${collection}/set/${encodeURIComponent(s.setSlug)}`}
                    className="rpc-card"
                    style={{ padding: 12, textDecoration: "none", color: "inherit", display: "block" }}
                  >
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 15, color: "var(--rpc-text-primary)", marginBottom: 6, lineHeight: 1.2 }}>{s.setName}</div>
                    <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                      {fmtCount(s.count)} edition{s.count === 1 ? "" : "s"} · {fmtUsd(s.fmvTotal)}
                    </div>
                  </Link>
                ))}
              </div>
            </Section>
          )}

          {/* ── Top Players in this Series ───────────────────────────────── */}
          {topPlayers.length > 0 && (
            <Section title="Top Players in this Series">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
                {topPlayers.map(p => (
                  <Link
                    key={p.playerSlug}
                    href={`/${collection}/player/${encodeURIComponent(p.playerSlug)}`}
                    className="rpc-card"
                    style={{ padding: 12, textDecoration: "none", color: "inherit", display: "block" }}
                  >
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", marginBottom: 6, lineHeight: 1.2 }}>{p.playerName}</div>
                    <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                      {fmtCount(p.count)} edition{p.count === 1 ? "" : "s"} · {fmtUsd(p.fmvTotal)}
                    </div>
                  </Link>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
