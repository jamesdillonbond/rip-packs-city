// app/(collections)/[collection]/pack/[dist_id]/page.tsx
// Phase 2A. Pack detail page.
//
// Data: get_pack_detail(collection_id, dist_id) for hero +
// get_pack_contents(collection_id, dist_id, 100, 0) for the contents grid.
// Returns notFound() when get_pack_detail returns null. Pinnacle never has
// pack data and will always 404 here.

import type { Metadata } from "next"
import Link from "next/link"
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

      <TopEvContributors
        contents={contents}
        poolTotalFmvUsd={detail.pool_total_fmv_usd}
        collectionUrlSlug={collection}
      />

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

// ── Top EV Contributors ─────────────────────────────────────────────────────
//
// Server component. The get_pack_contents RPC orders by (fmv_usd * drop_weight)
// DESC, so the top three EV contributors are just the first three rows of the
// contents page. Pool-EV percent is computed against detail.pool_total_fmv_usd
// which is itself the SUM of fmv_usd * drop_weight across the full pool —
// directly comparable. Hidden when the pool has no FMV data or fewer than two
// rows (one-row "top contributors" isn't useful).

function TopEvContributors({
  contents,
  poolTotalFmvUsd,
  collectionUrlSlug,
}: {
  contents: EditionTile[]
  poolTotalFmvUsd: number | null
  collectionUrlSlug: string
}) {
  if (!poolTotalFmvUsd || poolTotalFmvUsd <= 0) return null

  const ranked = contents
    .map((t) => {
      const fmv = typeof t.fmv_usd === "number" ? t.fmv_usd : 0
      const weight = typeof t.drop_weight === "number" ? t.drop_weight : 0
      return { tile: t, contribution: fmv * weight }
    })
    .filter((r) => r.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3)

  if (ranked.length < 2) return null

  const summed = ranked.reduce((acc, r) => acc + r.contribution, 0)
  const pct = (summed / poolTotalFmvUsd) * 100
  const pctLabel = pct >= 99.95 ? ">99%" : `${pct.toFixed(1)}%`
  const subtitle = `These ${ranked.length === 3 ? "three" : "two"} editions account for ${pctLabel} of pack EV.`

  return (
    <Section title="Top EV Contributors">
      <div style={{ marginTop: -4, marginBottom: 12, fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "var(--rpc-text-secondary)", letterSpacing: "0.04em" }}>
        {subtitle}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        {ranked.map(({ tile, contribution }) => {
          const sharePct = (contribution / poolTotalFmvUsd) * 100
          const editionHref = `/${collectionUrlSlug}/edition/${tile.route_slug}`
          return (
            <Link
              key={tile.route_slug}
              href={editionHref}
              prefetch={false}
              style={{ textDecoration: "none", color: "inherit" }}
            >
              <div className="rpc-card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6, height: "100%" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 18, color: "var(--rpc-text-primary)", lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {tile.player_name ?? tile.name ?? EM_DASH}
                  </div>
                  {tile.tier && <TierBadge tier={tile.tier} />}
                </div>
                {tile.set_name && (
                  <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.06em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {tile.set_name}
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, gap: 8 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>EV Contribution</div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 16, color: "var(--rpc-text-primary)", lineHeight: 1.1 }}>{fmtUsd(contribution)}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, textAlign: "right" }}>
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>Pool Share</div>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 16, color: "var(--rpc-text-primary)", lineHeight: 1.1 }}>{sharePct.toFixed(1)}%</div>
                  </div>
                </div>
              </div>
            </Link>
          )
        })}
      </div>
    </Section>
  )
}
