// app/(collections)/[collection]/pack/[dist_id]/page.tsx
// Phase 2A. Pack detail page.
//
// Data: get_pack_detail(collection_id, dist_id) for hero +
// get_pack_contents(collection_id, dist_id, 100, 0) for the contents grid.
// Returns notFound() when get_pack_detail returns null. Pinnacle never has
// pack data and will always 404 here.

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { Section, StatCell, TierBadge, EM_DASH, fmtCount, fmtUsd } from "@/components/entity/_shared"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"

export const revalidate = 600
export const dynamicParams = true

export async function generateStaticParams() {
  return [] as Array<{ collection: string; dist_id: string }>
}

interface PackDetail {
  title: string | null
  dist_id: string
  metadata: Record<string, unknown> | null
  nft_type: string | null
  image_url: string | null
  pool_size: number | null
  updated_at: string | null
  pack_ev_usd: number | null
  total_minted: number | null
  total_opened: number | null
  total_sealed: number | null
  collection_id: string
  depletion_pct: number | null
  first_seen_at: string | null
  distinct_tiers: string[] | null
  collection_slug: string | null
  total_drop_weight: number | null
  pool_total_fmv_usd: number | null
}

const PAGE_SIZE = 100

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
function rpc() { return supabaseAdmin as unknown as RpcClient }

async function fetchDetail(collectionId: string, distId: string): Promise<PackDetail | null> {
  const { data, error } = await rpc().rpc("get_pack_detail", { p_collection_id: collectionId, p_dist_id: distId })
  if (error) { console.error("[pack] detail error", error.message); return null }
  if (!data) return null
  if (Array.isArray(data)) return (data[0] as PackDetail) ?? null
  return data as PackDetail
}

async function fetchContents(collectionId: string, distId: string, limit: number, offset: number): Promise<EditionTile[]> {
  const { data, error } = await rpc().rpc("get_pack_contents", { p_collection_id: collectionId, p_dist_id: distId, p_limit: limit, p_offset: offset })
  if (error) { console.error("[pack] contents error", error.message); return [] }
  return Array.isArray(data) ? (data as EditionTile[]) : []
}

function pickPackImage(detail: PackDetail): string | null {
  if (detail.image_url) return detail.image_url
  const m = detail.metadata
  if (m && typeof m === "object") {
    const thumb = (m as Record<string, unknown>).thumbnail
    if (typeof thumb === "string" && thumb.length > 0) return thumb
  }
  return null
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(props: { params: Promise<{ collection: string; dist_id: string }> }): Promise<Metadata> {
  const { collection, dist_id } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  const detail = await fetchDetail(coll.id, dist_id)
  if (!detail) return {}
  const title = `${detail.title ?? `Pack ${dist_id}`} — ${coll.displayName} | Rip Packs City`
  const description = detail.pack_ev_usd && Number.isFinite(detail.pack_ev_usd)
    ? `Pack EV ${fmtUsd(detail.pack_ev_usd)} per slot · pool of ${fmtCount(detail.pool_size)} editions · ${fmtUsd(detail.pool_total_fmv_usd)} total pool FMV.`
    : `Pack contents pool of ${fmtCount(detail.pool_size)} editions for ${coll.displayName}.`
  return { title, description }
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function PackPage(props: { params: Promise<{ collection: string; dist_id: string }> }) {
  const { collection, dist_id } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  const detail = await fetchDetail(coll.id, dist_id)
  if (!detail) notFound()

  const contents = await fetchContents(coll.id, dist_id, PAGE_SIZE, 0)
  const image = pickPackImage(detail)
  const isUnenriched = (detail.total_minted ?? 0) === 0

  return (
    <div>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="rpc-card" style={{ padding: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: image ? "1fr minmax(0,240px)" : "1fr", gap: 24, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
            <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.18em", textTransform: "uppercase" }}>
              Pack · {detail.dist_id}
            </div>
            <h1 style={{ margin: 0, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 36, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", lineHeight: 1.05, textTransform: "uppercase" }}>
              {detail.title ?? `Pack ${detail.dist_id}`}
            </h1>
            {Array.isArray(detail.distinct_tiers) && detail.distinct_tiers.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                {detail.distinct_tiers.map(t => (
                  <TierBadge key={t} tier={t} />
                ))}
              </div>
            )}
          </div>
          {image && (
            <div style={{ width: "100%", maxWidth: 240, aspectRatio: "1 / 1", background: "rgba(0,0,0,0.4)", border: "1px solid var(--rpc-border)", borderRadius: 6, overflow: "hidden", justifySelf: "end" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt={detail.title ?? `Pack ${detail.dist_id}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            </div>
          )}
        </div>
      </section>

      {/* ── Stat strip ───────────────────────────────────────────────────── */}
      <section style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <StatCell label="Pool Size" value={fmtCount(detail.pool_size)} />
        <StatCell label="Drop Weight" value={fmtCount(detail.total_drop_weight)} />
        <StatCell label="Pool FMV" value={fmtUsd(detail.pool_total_fmv_usd)} />
        <StatCell label="EV / Slot" value={fmtUsd(detail.pack_ev_usd)} />
        <StatCell label="Sealed" value={isUnenriched ? EM_DASH : fmtCount(detail.total_sealed)} />
        <StatCell label="Depletion" value={isUnenriched || detail.depletion_pct == null ? EM_DASH : `${(detail.depletion_pct).toFixed(1)}%`} />
      </section>

      {isUnenriched && (
        <div className="rpc-mono" style={{ marginTop: 8, padding: "0 4px", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}>
          pack data not yet enriched · sealed counts and depletion will populate once on-chain mint events backfill
        </div>
      )}

      {/* ── Contents grid ────────────────────────────────────────────────── */}
      <Section title="Pack Contents">
        {contents.length === 0 ? (
          <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "'Share Tech Mono', monospace", fontSize: 12 }}>
            No contents resolved for this pack yet.
          </div>
        ) : (
          <EditionsGridPaginated
            collectionUrlSlug={collection}
            fetchUrl={`/api/entity/pack?collection=${encodeURIComponent(collection)}&dist_id=${encodeURIComponent(dist_id)}`}
            initial={contents}
            pageSize={PAGE_SIZE}
            showSetLink
            showSort
          />
        )}
      </Section>
    </div>
  )
}
