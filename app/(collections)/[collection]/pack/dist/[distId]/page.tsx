// app/(collections)/[collection]/pack/dist/[distId]/page.tsx
//
// Pack DISTRIBUTION (template) detail surface — server-rendered from cached
// EV snapshots (pack_table_rows ← pack_ev_latest ← pack_ev_history) plus
// the pack_drop_pool → editions → fmv join for the top-pulls table.
//
// This route describes a pack TEMPLATE (e.g. "Series 5 Common Pack"), not a
// specific minted pack instance. For an individual on-chain pack NFT (the
// lifecycle / rip view) see /[collection]/pack/[id]/page.tsx, which uses the
// get_pack_lifecycle RPC keyed on the pack NFT id.
//
// Top Shot and All Day reach this route today. PackTable routes its row
// click here via detailHref. Golazos packs surface was removed 2026-05-19
// — see lib/collections.ts pages array.

import type { Metadata } from "next"
import { topshotPackUrl } from "@/lib/pack-urls"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import PackHeroArt from "@/components/packs/PackHeroArt"
// tierChip moved to lib/tier-style.ts so this server component can call it;
// the version exported from PackTable.tsx ('use client') would throw at
// runtime — that's the bug this page was hitting before 2026-05-26.
import { tierChip } from "@/lib/tier-style"
import PackShareButton from "@/components/packs/PackShareButton"
import TrackedOutboundLink from "@/components/TrackedOutboundLink"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import { packJsonLd } from "@/lib/seo"

export const revalidate = 600
export const dynamicParams = true

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

interface PackTableRow {
  dist_id: string
  collection_id: string
  collection_name: string
  collection_slug: string
  title: string | null
  image_url: string | null
  nft_type: string | null
  tier: string | null
  pack_type: string | null
  description: string | null
  retail_price_usd: string | number | null
  slots: number | null
  total_minted: number | null
  total_opened: number | null
  total_sealed: number | null
  depletion_pct: number | null
  pack_ev: string | number | null
  gross_ev: string | number | null
  ev_pack_price: string | number | null
  value_ratio: string | number | null
  is_positive_ev: boolean | null
  fmv_coverage_pct: number | null
  edition_count: number | null
  total_unopened: number | null
  ev_depletion_pct: number | null
  ev_snapshotted_at: string | null
  ev_margin_pct: string | number | null
  is_rare_single_pack: boolean | null
  // Dual-price model (May 2026) — see /api/pack-ev for derivation rules.
  primary_price: string | number | null
  secondary_ask: string | number | null
  price_source: "primary" | "secondary" | "min" | "none" | null
  primary_available: boolean | null
  secondary_available: boolean | null
}

interface DistFallbackRow {
  metadata: Record<string, unknown> | null
  image_url: string | null
  title: string | null
}

interface DropPoolRow {
  edition_id: string
  drop_weight: string | number | null
}

interface EditionLite {
  id: string
  name: string | null
  tier: string | null
  external_id: string | null
  player_name: string | null
  set_name: string | null
}

interface FmvRow {
  edition_id: string
  fmv_usd: string | number | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

async function fetchPackRow(collectionId: string, distId: string): Promise<PackTableRow | null> {
  const { data, error } = await sb
    .from("pack_table_rows")
    .select("*")
    .eq("collection_id", collectionId)
    .eq("dist_id", distId)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error("[pack-detail] pack_table_rows error", error.message)
    return null
  }
  return (data as PackTableRow | null) ?? null
}

async function fetchDistFallback(collectionId: string, distId: string): Promise<DistFallbackRow | null> {
  const { data, error } = await sb
    .from("pack_distributions")
    .select("metadata, image_url, title")
    .eq("collection_id", collectionId)
    .eq("dist_id", distId)
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error("[pack-detail] pack_distributions error", error.message)
    return null
  }
  return (data as DistFallbackRow | null) ?? null
}

interface TopPull {
  editionId: string
  player: string
  setName: string
  tier: string | null
  dropWeight: number
  probabilityPct: number | null
  fmvUsd: number | null
  editionEv: number | null
  externalId: string | null
}

async function fetchTopPulls(
  collectionId: string,
  distId: string,
  totalUnopened: number | null,
  slots: number | null,
): Promise<TopPull[]> {
  const { data: poolRows, error: poolErr } = await sb
    .from("pack_drop_pool")
    .select("edition_id, drop_weight")
    .eq("dist_id", distId)
    .eq("collection_id", collectionId)
    .gt("drop_weight", 0)
    .order("drop_weight", { ascending: false })
    .limit(50)
  if (poolErr) {
    console.error("[pack-detail] pack_drop_pool error", poolErr.message)
    return []
  }
  const pool = (poolRows ?? []) as DropPoolRow[]
  if (pool.length === 0) return []

  const editionIds = pool.map((r) => r.edition_id)

  // Full-pool weight sum for the probability denominator. `pool` is the top-50
  // by drop_weight, so summing only its rows over-states the probability of
  // each pull (Pack audit B2). Fall back to that partial sum only as a last
  // resort, and surface probability as null when we can't compute the real
  // denominator.
  const [editionsRes, fmvRes, fullPoolWeightRes] = await Promise.all([
    sb.from("editions").select("id, name, tier, external_id, player_name, set_name").in("id", editionIds),
    sb.rpc("get_fmv_for_editions", {
      p_collection_id: collectionId,
      p_edition_ids: editionIds,
    }),
    sb.rpc("query_sql", {
      query: `
        SELECT COALESCE(SUM(drop_weight), 0)::numeric AS total_weight
        FROM pack_drop_pool
        WHERE dist_id = '${distId.replace(/'/g, "''")}'
          AND collection_id = '${collectionId.replace(/'/g, "''")}'
          AND drop_weight > 0
      `,
    }),
  ])

  if (editionsRes.error) console.error("[pack-detail] editions error", editionsRes.error.message)
  if (fmvRes.error) console.error("[pack-detail] fmv rpc error", fmvRes.error.message)
  if (fullPoolWeightRes.error) console.error("[pack-detail] full pool weight error", fullPoolWeightRes.error.message)

  const editionsById = new Map<string, EditionLite>()
  for (const e of (editionsRes.data ?? []) as EditionLite[]) editionsById.set(e.id, e)

  const fmvById = new Map<string, number>()
  for (const r of (fmvRes.data ?? []) as FmvRow[]) {
    const v = r.fmv_usd == null ? null : Number(r.fmv_usd)
    if (v !== null && Number.isFinite(v) && v > 0) fmvById.set(r.edition_id, v)
  }

  // Probability denominator: prefer cached total_unopened (true contents
  // remaining); otherwise use the full-pool drop_weight sum we just fetched.
  // Never fall back to summing only the top-50 weights — that inflates % (B2).
  const fullPoolWeight = Number(
    (fullPoolWeightRes.data as Array<{ total_weight: number | string }> | null)?.[0]?.total_weight ?? 0,
  )
  const denom = totalUnopened && totalUnopened > 0
    ? totalUnopened
    : fullPoolWeight > 0
      ? fullPoolWeight
      : null

  // Edition EV = the edition's contribution to one pack's gross EV.
  //   EV = FMV × (drop_weight / pool_weight) × slots
  // This reconciles with the cached pack_ev_history Gross EV KPI, which is
  // slots × Σ(per-edition probability × FMV) over the full pool. Pack D3:
  // earlier this column was raw fmv × drop_weight, a third EV methodology
  // that wouldn't sum to Gross EV at any pool size.
  const pulls: TopPull[] = pool.map((r) => {
    const ed = editionsById.get(r.edition_id)
    const dropWeight = Number(r.drop_weight ?? 0)
    const fmv = fmvById.get(r.edition_id) ?? null
    const probPct = denom ? (dropWeight / denom) * 100 : null
    const ev = fmv !== null && denom && denom > 0 && slots && slots > 0
      ? fmv * (dropWeight / denom) * slots
      : null
    // Prefer the clean denormalized columns. editions.name glues the series
    // number onto the set name for some Top Shot rows ("Base Set6"), so
    // splitting it gives a corrupted set cell (Pack 1e) — only fall back to
    // the split when the denorm columns are empty.
    const split = splitEditionName(ed?.name ?? null)
    const player = ed?.player_name?.trim() || split.player
    const setName = ed?.set_name?.trim() || split.setName
    return {
      editionId: r.edition_id,
      player,
      setName,
      tier: ed?.tier ?? null,
      dropWeight,
      probabilityPct: probPct,
      fmvUsd: fmv,
      editionEv: ev,
      externalId: ed?.external_id ?? null,
    }
  })

  pulls.sort((a, b) => {
    const ae = a.editionEv == null ? -Infinity : a.editionEv
    const be = b.editionEv == null ? -Infinity : b.editionEv
    if (ae !== be) return be - ae
    return b.dropWeight - a.dropWeight
  })

  return pulls.slice(0, 10)
}

const PACK_CONTENTS_PAGE_SIZE = 24

// Phase 2 (entity media): the visual "What's Inside" grid. get_pack_contents
// returns full EditionTile-shaped rows (thumbnail_url, route_slug, fmv_usd,
// drop_weight, hit_probability, …), so the moment art renders instead of the
// text-only Top-Pulls table below.
async function fetchPackContents(collectionId: string, distId: string, limit: number, offset: number): Promise<EditionTile[]> {
  const { data, error } = await sb.rpc("get_pack_contents", {
    p_collection_id: collectionId,
    p_dist_id: distId,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) { console.error("[pack-detail] get_pack_contents error", error.message); return [] }
  return Array.isArray(data) ? (data as EditionTile[]) : []
}

// PACKVIZ-GRID 2a — the top-5-by-FMV "hero strip". get_pack_contents orders by
// EV-per-slot (FMV × drop_weight), so a high-FMV / low-weight chase card sorts
// far down its list — the headline pulls need their own FMV-ordered fetch.
interface HeroEdition {
  route_slug: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  thumbnail_url: string | null
  fmv_usd: number | null
  hit_probability: number | null
}

async function fetchPackHeroEditions(collectionId: string, distId: string): Promise<HeroEdition[]> {
  const cid = collectionId.replace(/'/g, "''")
  const did = distId.replace(/'/g, "''")
  const { data, error } = await sb.rpc("query_sql", {
    query: `
      WITH tw AS (
        SELECT NULLIF(SUM(drop_weight), 0) AS total_weight
        FROM pack_drop_pool WHERE collection_id = '${cid}' AND dist_id = '${did}'
      )
      SELECT COALESCE(e.external_id, e.id::text) AS route_slug,
             e.player_name, e.set_name, e.tier::text AS tier, e.thumbnail_url,
             fmv.fmv_usd::float8 AS fmv_usd,
             (pdp.drop_weight / tw.total_weight)::float8 AS hit_probability
      FROM pack_drop_pool pdp
      CROSS JOIN tw
      JOIN editions e ON e.id = pdp.edition_id
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots WHERE edition_id = pdp.edition_id
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE pdp.collection_id = '${cid}' AND pdp.dist_id = '${did}'
        AND pdp.drop_weight > 0 AND fmv.fmv_usd IS NOT NULL AND fmv.fmv_usd > 0
      ORDER BY fmv.fmv_usd DESC
      LIMIT 5
    `,
  })
  if (error) { console.error("[pack-detail] hero editions error", error.message); return [] }
  return Array.isArray(data) ? (data as HeroEdition[]) : []
}

// PACKVIZ-GRID 2b — total exhausted (drop_weight = 0) pool rows, for the
// collapsed "Exhausted / pulled out" section header count.
async function fetchExhaustedCount(collectionId: string, distId: string): Promise<number> {
  const { count, error } = await sb
    .from("pack_drop_pool")
    .select("edition_id", { count: "exact", head: true })
    .eq("collection_id", collectionId)
    .eq("dist_id", distId)
    .eq("drop_weight", 0)
  if (error) { console.error("[pack-detail] exhausted count error", error.message); return 0 }
  return count ?? 0
}

// ── Sales history (Item 2 — traced via the pack_rips dist bridge) ────────────
// get_pack_sales_history returns kind-tagged rows ('top' = highest price,
// 'recent' = newest) for packs whose sold instances were later opened (the
// bridge only links sales whose pack rip resolved a dist_id — partial coverage
// that grows over time). Dist 901-class packs (sold, never re-opened) return
// zero rows and render the empty state.
interface PackSaleRow {
  kind: "top" | "recent" | string
  buyer_address: string | null
  seller_address: string | null
  sale_price: string | number | null
  sale_currency: string | null
  sealed_at: string | null
  tx_hash: string | null
}

async function fetchPackSalesHistory(collectionId: string, distId: string, limit = 10): Promise<PackSaleRow[]> {
  const { data, error } = await sb.rpc("get_pack_sales_history", {
    p_collection_id: collectionId,
    p_dist_id: distId,
    p_limit: limit,
  })
  if (error) { console.error("[pack-detail] get_pack_sales_history error", error.message); return [] }
  return Array.isArray(data) ? (data as PackSaleRow[]) : []
}

// editions.name is "Player Name — Set Name" (em-dash). Some rows are NULL.
// Fall back gracefully so the table doesn't render literal "null —" cells.
function splitEditionName(name: string | null): { player: string; setName: string } {
  if (!name) return { player: "Unknown", setName: "" }
  const idx = name.indexOf("—")
  if (idx === -1) return { player: name.trim(), setName: "" }
  return { player: name.slice(0, idx).trim() || "Unknown", setName: name.slice(idx + 1).trim() }
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  if (Math.abs(v) >= 100) return `$${Math.round(v).toLocaleString()}`
  return `$${v.toFixed(2)}`
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return `${v.toFixed(1)}%`
}

function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return v.toLocaleString()
}

// ── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata(
  props: { params: Promise<{ collection: string; distId: string }> },
): Promise<Metadata> {
  const { collection, distId } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return {}
  const row = await fetchPackRow(coll.id, distId)
  const fb = row ? null : await fetchDistFallback(coll.id, distId)
  const title = row?.title ?? fb?.title ?? "Pack"
  if (!row && !fb) return {}
  const tierLabel = row?.tier ? String(row.tier).charAt(0).toUpperCase() + String(row.tier).slice(1) : ""
  const metaTitle = `${title}${tierLabel ? ` — ${tierLabel}` : ""} | ${coll.displayName} | Rip Packs City`
  const grossEv = num(row?.gross_ev ?? null)
  const price = num(row?.retail_price_usd ?? null)
  const ratio = num(row?.value_ratio ?? null)
  const descParts = [
    `${title} on ${coll.displayName}.`,
    price !== null ? `Retail ${fmtUsd(price)}.` : null,
    grossEv !== null ? `Gross EV ${fmtUsd(grossEv)}.` : null,
    ratio !== null ? `Value ratio ${ratio.toFixed(2)}x.` : null,
    "Pack EV, top pulls, and depletion based on Rip Packs City's cached snapshot.",
  ].filter(Boolean) as string[]
  const canonical = `${BASE_URL}/${collection}/pack/dist/${encodeURIComponent(distId)}`
  const ogImage = `${BASE_URL}/api/og/pack?distId=${encodeURIComponent(distId)}&collection=${encodeURIComponent(collection)}`
  return {
    title: metaTitle,
    description: descParts.join(" "),
    alternates: { canonical },
    openGraph: {
      title: metaTitle,
      description: descParts.join(" "),
      url: canonical,
      siteName: "Rip Packs City",
      type: "website",
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title: metaTitle,
      description: descParts.join(" "),
      images: [ogImage],
    },
  }
}

// ── Page ────────────────────────────────────────────────────────────────────

export default async function PackDetailPage(
  props: { params: Promise<{ collection: string; distId: string }> },
) {
  const { collection, distId } = await props.params
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) notFound()

  const row = await fetchPackRow(coll.id, distId)
  const fallback = row ? null : await fetchDistFallback(coll.id, distId)
  if (!row && !fallback) notFound()

  // When pack_table_rows misses (newly minted dist the cron hasn't picked up),
  // synthesize a minimal shape from pack_distributions. EV / depletion will
  // render as em-dash but the page still resolves with a hero + buy link.
  const merged: PackTableRow = row ?? {
    dist_id: distId,
    collection_id: coll.id,
    collection_name: coll.displayName,
    collection_slug: collection,
    title: fallback?.title ?? null,
    image_url: fallback?.image_url ?? null,
    nft_type: null,
    tier: typeof fallback?.metadata?.tier === "string" ? (fallback.metadata.tier as string) : null,
    pack_type: typeof fallback?.metadata?.pack_type === "string" ? (fallback.metadata.pack_type as string) : null,
    description: null,
    retail_price_usd:
      typeof fallback?.metadata?.retail_price_usd === "number"
        ? (fallback.metadata.retail_price_usd as number)
        : typeof fallback?.metadata?.retail_price_usd === "string"
          ? (fallback.metadata.retail_price_usd as string)
          : null,
    slots:
      typeof fallback?.metadata?.number_of_pack_slots === "number"
        ? (fallback.metadata.number_of_pack_slots as number)
        : typeof fallback?.metadata?.number_of_pack_slots === "string"
          ? Number(fallback.metadata.number_of_pack_slots)
          : null,
    total_minted: null,
    total_opened: null,
    total_sealed: null,
    depletion_pct: null,
    pack_ev: null,
    gross_ev: null,
    ev_pack_price: null,
    value_ratio: null,
    is_positive_ev: null,
    fmv_coverage_pct: null,
    edition_count: null,
    total_unopened: null,
    ev_depletion_pct: null,
    ev_snapshotted_at: null,
    ev_margin_pct: null,
    is_rare_single_pack: null,
    primary_price: null,
    secondary_ask: null,
    price_source: null,
    primary_available: null,
    secondary_available: null,
  }

  const distMetadata = fallback?.metadata ?? (await fetchDistFallback(coll.id, distId))?.metadata ?? null

  const [topPulls, packContents, heroEditions, exhaustedCount, salesHistory] = await Promise.all([
    fetchTopPulls(coll.id, distId, num(merged.total_unopened), merged.slots ?? null),
    fetchPackContents(coll.id, distId, PACK_CONTENTS_PAGE_SIZE, 0),
    fetchPackHeroEditions(coll.id, distId),
    fetchExhaustedCount(coll.id, distId),
    fetchPackSalesHistory(coll.id, distId, 10),
  ])

  // Defensive: pack_table_rows.tier is typed string|null but coerce in case
  // the view ever returns a non-string. Same for title.
  const tier = String(merged.tier ?? "common").toLowerCase()
  const chip = tierChip(tier)
  const tierAccent = chip.color
  const title = String(merged.title ?? "Pack")
  const grossEv = num(merged.gross_ev)
  const packEv = num(merged.pack_ev)
  const valueRatio = num(merged.value_ratio)
  const evMargin = num(merged.ev_margin_pct)
  const fmvCoverage = merged.fmv_coverage_pct
  const depletion = merged.depletion_pct
  const totalUnopened = num(merged.total_unopened)
  const editionCount = num(merged.edition_count)
  const retailPrice = num(merged.retail_price_usd)
  const evPackPrice = num(merged.ev_pack_price)
  const primaryPrice = num(merged.primary_price)
  const secondaryAsk = num(merged.secondary_ask)
  const priceSource = merged.price_source ?? null
  const primaryAvailable = merged.primary_available === true
  const secondaryAvailable = merged.secondary_available === true
  // EV anchor: prefer the dual-price packPrice when the EV cron has filled in
  // the new columns; fall back to the cached ev_pack_price, then retail.
  const livePrice =
    priceSource === "primary" ? primaryPrice
    : priceSource === "secondary" ? secondaryAsk
    : priceSource === "min" ? primaryPrice
    : evPackPrice ?? retailPrice
  const isPositive = merged.is_positive_ev === true
  const snapshottedAt = merged.ev_snapshotted_at
  // Reward / quest packs ship with retail_price_usd = 0 (Pack D1). Value-ratio
  // and EV-margin verdicts divide by retail, so they produce garbage on free
  // packs — gate them off and surface a "Reward pack" badge instead.
  const isRewardPack = retailPrice === 0
  const showPriceVerdict = !isRewardPack && priceSource !== "none"

  // Does this distribution have a real, indexed drop pool? Gates the
  // pull-odds-by-tier panel (which otherwise renders pack-count-by-tier as if
  // it were pool entries on no-pool packs — Pack 1b) and the EV-sentinel
  // honesty path (Pack 1c).
  const hasDropPool = topPulls.length > 0 || packContents.length > 0 || (editionCount != null && editionCount > 0)

  // 1c — A no-pool pack's latest EV row is a sentinel (edition_count 0 /
  // fmv_coverage null|0). Rendering "$0.00 Gross EV / Net +$0.00" reads as
  // "this pack is worthless" and contradicts the empty state below; show an
  // em-dash + "awaiting pool data" and suppress the Net line instead.
  const isSentinelEv = !hasDropPool && ((editionCount ?? 0) === 0 || !fmvCoverage)

  // 1f — Hero montage fallback: top-4-by-FMV pool thumbnails, used by
  // PackHeroArt when the pack's own image_url is dead/missing.
  const montageThumbs = packContents
    .filter((e) => !!e.thumbnail_url)
    .slice()
    .sort((a, b) => (Number(b.fmv_usd) || 0) - (Number(a.fmv_usd) || 0))
    .map((e) => e.thumbnail_url as string)
    .slice(0, 4)

  // ── Tier-count metadata (PACKVIZ) ──────────────────────────────────────────
  // compute-topshot-pack-ev v20 persists per-pack remaining/original counts-by-tier
  // + total_unopened/total_pack_count into pack_distributions.metadata as its EV
  // sweep touches each pack. Present only on packs the v20 sweep has reached.
  const tierCountsUpdatedAt = typeof distMetadata?.tier_counts_updated_at === "string" ? distMetadata.tier_counts_updated_at : null
  const metaTotalUnopened = num((distMetadata?.total_unopened as string | number | null | undefined) ?? null)
  const metaTotalPackCount = num((distMetadata?.total_pack_count as string | number | null | undefined) ?? null)
  const remainingByTier = distMetadata && typeof distMetadata.remaining_by_tier === "object" && distMetadata.remaining_by_tier !== null
    ? (distMetadata.remaining_by_tier as Record<string, number>) : null
  const originalByTier = distMetadata && typeof distMetadata.original_counts_by_tier === "object" && distMetadata.original_counts_by_tier !== null
    ? (distMetadata.original_counts_by_tier as Record<string, number>) : null
  // Freshest packs-remaining figure: prefer the v20 metadata, else the cached view.
  const liveUnopened = metaTotalUnopened ?? totalUnopened
  const oddsSlots = merged.slots && merged.slots > 0 ? merged.slots : null

  // 2a — Depletion: prefer the v20 metadata-derived figure, fall back to the cached
  // depletion_pct, and HIDE the tile entirely when neither source exists (never 0%).
  const depletionPct: number | null = (() => {
    if (metaTotalPackCount && metaTotalPackCount > 0 && metaTotalUnopened != null) {
      return Math.max(0, Math.min(100, ((metaTotalPackCount - metaTotalUnopened) / metaTotalPackCount) * 100))
    }
    return depletion != null ? Number(depletion) : null
  })()

  // 2d — EV verdict coverage gate: below 80% FMV coverage the EV is a lower bound,
  // not an authoritative verdict — render it neutral (no red/green) with a caveat.
  const COVERAGE_FLOOR = 80
  const coverageOk = fmvCoverage != null && fmvCoverage >= COVERAGE_FLOOR
  const showColoredVerdict = showPriceVerdict && coverageOk
  const coverageCaveat = showPriceVerdict && !coverageOk && fmvCoverage != null
    ? `${fmvCoverage}% FMV cov — EV is a floor`
    : null

  // One-line summary above the KPI grid. Names the EV anchor explicitly so
  // the user knows whether the verdict is computed against retail or P2P ask.
  // priceSource = 'none' suppresses the verdict entirely.
  const evAnchorSummary: string | null = (() => {
    if (isRewardPack) return "Reward pack — distributed for free, no price-based verdict."
    if (priceSource === "none") return "Pack not currently available for purchase"
    if (priceSource === "primary" && primaryPrice != null) {
      return `EV computed against [PRIMARY: ${fmtUsd(primaryPrice)}] — primary listing is the cheapest path to acquire this pack right now.`
    }
    if (priceSource === "secondary" && secondaryAsk != null) {
      return `EV computed against [SECONDARY: ${fmtUsd(secondaryAsk)}] — cheapest path to acquire this pack right now.`
    }
    if (priceSource === "min" && primaryPrice != null && secondaryAsk != null) {
      return `Primary (${fmtUsd(primaryPrice)}) and secondary (${fmtUsd(secondaryAsk)}) are within 1% — both are valid EV anchors.`
    }
    return null
  })()

  const packListingUuid = typeof distMetadata?.uuid === "string" ? distMetadata.uuid : null
  // Pack audit S2: suppress the buy CTA when the EV cron has determined the
  // pack isn't currently for sale (price_source = "none"); also gate on the
  // reward-pack flag so we don't tell users to "buy" a free reward pack.
  const buyUrl = collection === "nba-top-shot" && packListingUuid && !isRewardPack && priceSource !== "none"
    ? topshotPackUrl({ distId, packListingUuid })
    : null
  const buyCtaLabel = priceSource === "primary" || priceSource === "min"
    ? "Buy primary"
    : priceSource === "secondary"
      ? "Buy on secondary market"
      : "Buy on Top Shot"

  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1)
  // 7 — the pack_type chip is suppressed when it's just the generic "pack"
  // (it's redundant on a pack page, and rendered tight beside the tier chip it
  // read as "Fandompack"). Only show a meaningful type (box / case / bundle …).
  const rawPackType = String(merged.pack_type ?? "").trim()
  const packTypeLabel = rawPackType.toLowerCase() === "pack" ? "" : rawPackType
  // 1d — when slots is unknown render nothing here. The old fallback to
  // packTypeLabel duplicated the pack-type chip beside it ("Pack pack").
  const slotsLabel = merged.slots && merged.slots > 0
    ? `${merged.slots} slot${merged.slots === 1 ? "" : "s"}`
    : null

  const cardStyle: React.CSSProperties = {
    background: "rgba(13,13,13,0.92)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: 18,
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(packJsonLd({ title, image: merged.image_url, collectionUrlSlug: collection, distId, retailPriceUsd: retailPrice })) }}
      />
      <Breadcrumbs
        items={[
          { name: "Home", href: "/" },
          { name: coll.displayName, href: `/${collection}` },
          { name: title },
        ]}
      />
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section style={cardStyle}>
        <div className="rpc-entity-hero rpc-entity-hero--260">
          <div
            style={{
              width: 260,
              height: 260,
              borderRadius: 6,
              overflow: "hidden",
              background: "rgba(0,0,0,0.4)",
              border: `1px solid ${tierAccent}33`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <PackHeroArt url={merged.image_url} tier={tier} title={title} montage={montageThumbs} size={260} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  letterSpacing: "0.2em",
                  color: "rgba(255,255,255,0.4)",
                  textTransform: "uppercase",
                }}
              >
                {coll.displayName} · Pack #{distId}
              </span>
            </div>
            <h1
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontWeight: 900,
                fontSize: 32,
                letterSpacing: "0.04em",
                color: "#fff",
                lineHeight: 1.05,
                textTransform: "uppercase",
              }}
            >
              {title}
            </h1>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span
                style={{
                  display: "inline-block",
                  padding: "3px 10px",
                  borderRadius: 4,
                  fontSize: 11,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  fontWeight: 700,
                  color: chip.color,
                  background: chip.background,
                  border: chip.border,
                }}
              >
                {tierLabel}
              </span>
              {packTypeLabel && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    color: "rgba(255,255,255,0.7)",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    textTransform: "capitalize",
                  }}
                >
                  {packTypeLabel}
                </span>
              )}
              {slotsLabel && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "rgba(255,255,255,0.55)",
                  }}
                >
                  {slotsLabel}
                </span>
              )}
              {isPositive && grossEv !== null && showPriceVerdict && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "rgb(110,231,183)",
                    background: "rgba(16,185,129,0.12)",
                    border: "1px solid rgba(16,185,129,0.4)",
                  }}
                >
                  +EV
                </span>
              )}
              {isRewardPack && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 700,
                    color: "rgb(125,211,252)",
                    background: "rgba(14,165,233,0.10)",
                    border: "1px solid rgba(14,165,233,0.40)",
                  }}
                  title="Distributed for free (retail price $0)."
                >
                  Reward pack
                </span>
              )}
              {merged.is_rare_single_pack && (
                <span
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    color: "rgb(252,211,77)",
                    background: "rgba(234,179,8,0.10)",
                    border: "1px solid rgba(234,179,8,0.40)",
                  }}
                  title="EV represents one specific ultra-rare moment rather than a probabilistic pull."
                >
                  Single rare edition
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
              {buyUrl ? (
                <TrackedOutboundLink
                  href={buyUrl}
                  payload={{
                    surface: "pack_dist",
                    destination: "topshot",
                    setName: title,
                    tier,
                    fmv: Number.isFinite(livePrice as number) ? (livePrice as number) : null,
                    buyUrl,
                  }}
                  style={{
                    display: "inline-block",
                    padding: "8px 16px",
                    background: "var(--rpc-red)",
                    color: "#fff",
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontSize: 12,
                    borderRadius: 4,
                    textDecoration: "none",
                  }}
                >
                  {buyCtaLabel}
                </TrackedOutboundLink>
              ) : null}
              <PackShareButton url={`${BASE_URL}/${collection}/pack/dist/${encodeURIComponent(distId)}`} />
              <Link
                href={`/${collection}/packs`}
                style={{
                  display: "inline-block",
                  padding: "8px 16px",
                  background: "transparent",
                  color: "rgba(255,255,255,0.7)",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  fontSize: 12,
                  borderRadius: 4,
                  border: "1px solid rgba(255,255,255,0.2)",
                  textDecoration: "none",
                }}
              >
                ← All packs
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── EV anchor summary ────────────────────────────────────────────── */}
      {evAnchorSummary && (
        <section
          style={{
            background: "rgba(13,13,13,0.92)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            padding: "10px 14px",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: isRewardPack || priceSource === "none" ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.75)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {showPriceVerdict && (
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--rpc-red)",
                flexShrink: 0,
                display: "inline-block",
              }}
            />
          )}
          <span>{evAnchorSummary}</span>
        </section>
      )}

      {/* ── KPI grid ─────────────────────────────────────────────────────── */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <DualPriceKpi
          primaryPrice={primaryPrice}
          secondaryAsk={secondaryAsk}
          priceSource={priceSource}
          primaryAvailable={primaryAvailable}
          secondaryAvailable={secondaryAvailable}
          fallbackPrice={livePrice}
          retailPrice={retailPrice}
        />
        <KpiCell
          label="Gross EV"
          value={isSentinelEv ? "—" : fmtUsd(grossEv)}
          sub={isSentinelEv ? "awaiting pool data" : isRewardPack ? "Reward pack — net vs $0 retail not meaningful" : priceSource === "none" ? "No anchor — verdict suppressed" : coverageCaveat ? (packEv !== null ? `Net ${packEv >= 0 ? "+" : ""}${fmtUsd(Math.abs(packEv))} · ${coverageCaveat}` : coverageCaveat) : packEv !== null ? `Net ${packEv >= 0 ? "+" : ""}${fmtUsd(Math.abs(packEv))}` : undefined}
          color={isSentinelEv || !showColoredVerdict || packEv === null ? undefined : packEv >= 0 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        <KpiCell
          label="Value ratio"
          value={!showPriceVerdict || valueRatio === null ? "—" : `${valueRatio.toFixed(2)}x`}
          sub={isRewardPack ? "Free pack — n/a" : priceSource === "none" ? undefined : coverageCaveat ? (evMargin === null ? coverageCaveat : `${fmtPct(evMargin)} margin · ${coverageCaveat}`) : evMargin === null ? undefined : `${fmtPct(evMargin)} margin`}
          color={!showColoredVerdict || valueRatio === null ? undefined : valueRatio >= 1 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        <KpiCell
          label="FMV coverage"
          value={fmvCoverage === null ? "—" : `${fmvCoverage}%`}
          sub={editionCount === null ? undefined : `${editionCount} editions`}
        />
        {depletionPct !== null && (
          <KpiCell
            label="Depletion"
            value={`${depletionPct.toFixed(depletionPct >= 10 ? 0 : 1)}%`}
            sub={tierCountsUpdatedAt ? "live pool" : merged.ev_depletion_pct === null ? undefined : `Pool ${merged.ev_depletion_pct}%`}
          />
        )}
        <KpiCell
          label="Packs remaining"
          value={fmtCount(liveUnopened)}
          sub={metaTotalPackCount !== null ? `of ${fmtCount(metaTotalPackCount)} minted` : undefined}
        />
      </section>

      {/* ── Packs Content Remaining (Item 1 — TS-style donut + tier bars) ── */}
      <PacksContentRemaining
        unopened={liveUnopened}
        totalMinted={metaTotalPackCount}
        remainingByTier={remainingByTier}
        originalByTier={originalByTier}
        updatedAt={tierCountsUpdatedAt}
        hasDropPool={hasDropPool}
        tierAccent={tierAccent}
      />

      {/* ── Pull odds by tier (PACKVIZ 2b) ───────────────────────────────── */}
      <TierOddsPanel
        remainingByTier={remainingByTier}
        originalByTier={originalByTier}
        slots={oddsSlots}
        updatedAt={tierCountsUpdatedAt}
        hasDropPool={hasDropPool}
      />

      {/* ── Top pulls hero strip (PACKVIZ-GRID 2a) ───────────────────────── */}
      {heroEditions.length > 0 && <PackHeroStrip collection={collection} editions={heroEditions} />}

      {/* ── Sales History (Item 2 — Top + Recent Purchases) ──────────────── */}
      <PackSalesHistory rows={salesHistory} />

      {/* ── What's inside (visual grid) ──────────────────────────────────── */}
      {packContents.length > 0 && (
        <section style={cardStyle}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
            <h2
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: 18,
                letterSpacing: "0.06em",
                color: "#fff",
                textTransform: "uppercase",
              }}
            >
              What&apos;s Inside
            </h2>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
              {fmvCoverage !== null && editionCount
                ? `FMV priced ${fmtCount(Math.round((fmvCoverage / 100) * editionCount))} of ${editionCount} (${fmvCoverage}%)`
                : editionCount ? `${editionCount} editions in pool` : "pullable editions"}
            </span>
          </div>
          <EditionsGridPaginated
            collectionUrlSlug={collection}
            fetchUrl={`/api/entity/pack?collection=${encodeURIComponent(collection)}&dist_id=${encodeURIComponent(distId)}`}
            initial={packContents}
            pageSize={PACK_CONTENTS_PAGE_SIZE}
            showSetLink
            showSort
            packMode
            exhaustedTotal={exhaustedCount}
          />
        </section>
      )}

      {/* ── Top pulls ────────────────────────────────────────────────────── */}
      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
          <h2
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: 18,
              letterSpacing: "0.06em",
              color: "#fff",
              textTransform: "uppercase",
            }}
          >
            Top pulls by EV
          </h2>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            {topPulls.length === 0 ? "computing pack contents…" : `top ${topPulls.length} of ${editionCount ?? "?"}`}
          </span>
        </div>
        {topPulls.length === 0 ? (
          <div
            style={{
              padding: "12px 14px",
              border: "1px dashed rgba(255,255,255,0.1)",
              borderRadius: 6,
              color: "rgba(255,255,255,0.4)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
          >
            No drop-pool data indexed for this distribution yet. Check back after the next pack-EV cron tick.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <Th>Player</Th>
                  <Th>Set</Th>
                  <Th>Tier</Th>
                  <Th align="right">Drop %</Th>
                  <Th align="right">FMV</Th>
                  <Th align="right">Edition EV</Th>
                </tr>
              </thead>
              <tbody>
                {topPulls.map((p) => (
                  <tr key={p.editionId} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <Td>
                      {p.externalId ? (
                        <Link href={`/${collection}/edition/${encodeURIComponent(p.externalId)}`} style={{ color: "#fff", textDecoration: "none" }}>
                          {p.player}
                        </Link>
                      ) : (
                        <span style={{ color: "#fff" }}>{p.player}</span>
                      )}
                    </Td>
                    <Td color="rgba(255,255,255,0.6)">{p.setName || "—"}</Td>
                    <Td color={p.tier ? tierChip(String(p.tier)).color : undefined}>{p.tier ? String(p.tier).charAt(0).toUpperCase() + String(p.tier).slice(1) : "—"}</Td>
                    <Td align="right">{p.probabilityPct === null ? "—" : `${p.probabilityPct.toFixed(2)}%`}</Td>
                    <Td align="right">{fmtUsd(p.fmvUsd)}</Td>
                    <Td align="right" color={p.editionEv !== null && p.editionEv > 0 ? "rgb(110,231,183)" : undefined}>
                      {fmtUsd(p.editionEv)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
          Edition EV = FMV × (drop_weight / pool_weight) × slots. Sums to Gross EV over the full pool. Snapshotted{" "}
          {snapshottedAt ? new Date(snapshottedAt).toLocaleString() : "—"}. Methodology: cached pack_ev_history via the
          compute-pack-ev edge function.
        </div>
      </section>
    </div>
  )
}

// ── Tiny presentational helpers ────────────────────────────────────────────

function KpiCell({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 22,
          letterSpacing: "0.02em",
          color: color ?? "#fff",
          marginTop: 4,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "rgba(255,255,255,0.45)",
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  )
}

function DualPriceKpi({
  primaryPrice,
  secondaryAsk,
  priceSource,
  primaryAvailable,
  secondaryAvailable,
  fallbackPrice,
  retailPrice,
}: {
  primaryPrice: number | null
  secondaryAsk: number | null
  priceSource: "primary" | "secondary" | "min" | "none" | null
  primaryAvailable: boolean
  secondaryAvailable: boolean
  fallbackPrice: number | null
  retailPrice: number | null
}) {
  // Legacy fallback: when the EV cron hasn't populated the new columns,
  // render the single-line "Pack price" KPI as before.
  if (priceSource === null) {
    return (
      <KpiCell
        label="Pack price"
        value={fmtUsd(fallbackPrice)}
        sub={retailPrice !== null && fallbackPrice !== null && retailPrice !== fallbackPrice ? `Retail ${fmtUsd(retailPrice)}` : undefined}
      />
    )
  }

  const primaryLive = primaryAvailable && primaryPrice != null && primaryPrice > 0
  const secondaryLive = secondaryAvailable && secondaryAsk != null && secondaryAsk > 0
  const primaryAnchor = priceSource === "primary" || priceSource === "min"
  const secondaryAnchor = priceSource === "secondary" || priceSource === "min"

  const Row = ({
    label,
    value,
    anchor,
    muted,
  }: {
    label: string
    value: string
    anchor: boolean
    muted: boolean
  }) => (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, lineHeight: 1.25 }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          minWidth: 64,
          display: "inline-block",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: anchor ? 800 : 600,
          fontSize: 18,
          letterSpacing: "0.02em",
          fontVariantNumeric: "tabular-nums",
          color: anchor ? "var(--rpc-red)" : muted ? "rgba(255,255,255,0.45)" : "#fff",
        }}
      >
        {value}
      </span>
      {anchor && (
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--rpc-red)",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
      )}
    </div>
  )

  return (
    <div
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 6,
        padding: 12,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          marginBottom: 6,
        }}
      >
        Pack price
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Row
          label="Primary"
          value={primaryLive ? fmtUsd(primaryPrice) : "SOLD OUT"}
          anchor={primaryAnchor && primaryLive}
          muted={!primaryLive}
        />
        <Row
          label="Secondary"
          value={secondaryLive ? fmtUsd(secondaryAsk) : "—"}
          anchor={secondaryAnchor && secondaryLive}
          muted={!secondaryLive}
        />
      </div>
    </div>
  )
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: "8px 10px",
        fontSize: 9,
        letterSpacing: "0.15em",
        textTransform: "uppercase",
        color: "rgba(255,255,255,0.45)",
        fontWeight: 700,
      }}
    >
      {children}
    </th>
  )
}

function Td({ children, align = "left", color }: { children: React.ReactNode; align?: "left" | "right"; color?: string }) {
  return (
    <td
      style={{
        textAlign: align,
        padding: "8px 10px",
        color: color ?? "rgba(255,255,255,0.85)",
      }}
    >
      {children}
    </td>
  )
}

// ── Top pulls hero strip (PACKVIZ-GRID 2a) ──────────────────────────────────
// The "what am I chasing" view: the 5 highest-FMV pullable editions, bigger
// art + FMV + hit% chip, in a horizontally-scrolling strip above the grid.

function PackHeroStrip({ collection, editions }: { collection: string; editions: HeroEdition[] }) {
  return (
    <section
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          Top chases
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          highest-FMV pulls in this pack
        </span>
      </div>
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
        {editions.map((e, i) => {
          const chip = tierChip(String(e.tier ?? "common"))
          const hitPct = e.hit_probability != null && Number.isFinite(e.hit_probability)
            ? `${(e.hit_probability * 100).toFixed(2)}%`
            : null
          const inner = (
            <>
              <div
                style={{
                  width: "100%",
                  aspectRatio: "1 / 1",
                  borderRadius: 4,
                  overflow: "hidden",
                  background: "rgba(0,0,0,0.4)",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {e.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={e.thumbnail_url}
                    alt={e.player_name ?? "Edition"}
                    loading={i < 5 ? "eager" : "lazy"}
                    decoding="async"
                    style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                  />
                ) : (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.35)" }}>No image</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                <span
                  style={{
                    display: "inline-block",
                    padding: "1px 6px",
                    borderRadius: 3,
                    fontSize: 9,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                    color: chip.color,
                    background: chip.background,
                    border: chip.border,
                  }}
                >
                  {String(e.tier ?? "—").charAt(0).toUpperCase() + String(e.tier ?? "").slice(1).toLowerCase()}
                </span>
                {hitPct && (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.5)" }}>
                    Hit {hitPct}
                  </span>
                )}
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, color: "#fff", lineHeight: 1.15 }}>
                {e.player_name ?? "Unknown"}
              </div>
              {e.set_name && (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.5)", marginTop: 1 }}>
                  {e.set_name}
                </div>
              )}
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, color: "var(--rpc-red)", marginTop: 4 }}>
                {fmtUsd(e.fmv_usd)}
              </div>
            </>
          )
          const cardStyleStrip: React.CSSProperties = {
            flex: "0 0 auto",
            width: 150,
            textDecoration: "none",
            color: "inherit",
            background: "rgba(255,255,255,0.02)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 6,
            padding: 10,
          }
          return e.route_slug ? (
            <Link key={e.route_slug + i} href={`/${collection}/edition/${encodeURIComponent(e.route_slug)}`} style={cardStyleStrip}>
              {inner}
            </Link>
          ) : (
            <div key={i} style={cardStyleStrip}>{inner}</div>
          )
        })}
      </div>
    </section>
  )
}

// ── Pull odds by tier (PACKVIZ 2b) ──────────────────────────────────────────
// Top Shot's own pack pages lead with per-tier hit chances; RPC now has the data
// (compute-topshot-pack-ev v20 persists remaining/original counts-by-tier into
// pack_distributions.metadata). Renders only when those counts are present, so it
// fills in per pack as the v20 EV sweep reaches it.

const TIER_RARITY_ORDER = ["ultimate", "legendary", "anthology", "autograph", "rare", "fandom", "common"]

function relTimeShort(iso: string | null): string {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ""
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// `poolRemaining` is the total number of remaining POOL ENTRIES (Σ over tiers
// of remaining_by_tier), NOT packs-remaining. Dividing by packs-remaining was
// the Pack 1a bug (Common showed 596% = 328 entries / 55 packs).
function packOddsLabel(remaining: number, poolRemaining: number | null, slots: number | null): string {
  if (remaining <= 0) return "depleted"
  if (!poolRemaining || poolRemaining <= 0 || !slots || slots <= 0) return "—"
  const p = remaining / poolRemaining
  const atLeastOne = 1 - Math.pow(1 - p, slots)
  if (atLeastOne <= 0) return "—"
  if (atLeastOne >= 0.999) return "~every pack"
  const oneIn = Math.round(1 / atLeastOne)
  return `~1 in ${oneIn.toLocaleString()}`
}

function TierOddsPanel({
  remainingByTier,
  originalByTier,
  slots,
  updatedAt,
  hasDropPool,
}: {
  remainingByTier: Record<string, number> | null
  originalByTier: Record<string, number> | null
  slots: number | null
  updatedAt: string | null
  hasDropPool: boolean
}) {
  if (!remainingByTier || !originalByTier) return null
  // 1b — On no-pool packs the v20 metadata writes pack-count-by-tier here, not
  // pool entries, so the percentages and odds would be fabricated. Only render
  // when there's a real indexed drop pool; the Top-Pulls empty state covers
  // the rest.
  if (!hasDropPool) return null
  // 1a — denominator is the remaining POOL ENTRIES across all tiers.
  const poolRemaining = Object.values(remainingByTier).reduce<number>((s, v) => s + (Number(v) || 0), 0)
  const tiers = TIER_RARITY_ORDER.filter((t) => Number(originalByTier[t] ?? 0) > 0)
  for (const k of Object.keys(originalByTier)) {
    if (!TIER_RARITY_ORDER.includes(k) && Number(originalByTier[k] ?? 0) > 0) tiers.push(k)
  }
  if (tiers.length === 0) return null

  return (
    <section
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          Pull odds by tier
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          {slots && slots > 0 ? `${slots} slots/pack` : "per pack"}
          {updatedAt ? ` · as of ${relTimeShort(updatedAt)}` : ""}
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <Th>Tier</Th>
              <Th align="right">Remaining</Th>
              <Th align="right">% of pool</Th>
              <Th align="right">Odds / pack</Th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((t) => {
              const remaining = Number(remainingByTier[t] ?? 0)
              const original = Number(originalByTier[t] ?? 0)
              const chip = tierChip(t)
              const pctOfPool = poolRemaining > 0 ? (remaining / poolRemaining) * 100 : null
              return (
                <tr key={t} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                  <Td>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontSize: 10,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        fontWeight: 700,
                        color: chip.color,
                        background: chip.background,
                        border: chip.border,
                      }}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </span>
                  </Td>
                  <Td align="right" color="rgba(255,255,255,0.85)">
                    {remaining.toLocaleString()} <span style={{ color: "rgba(255,255,255,0.4)" }}>/ {original.toLocaleString()}</span>
                  </Td>
                  <Td align="right" color="rgba(255,255,255,0.6)">
                    {pctOfPool === null ? "—" : pctOfPool < 0.1 && pctOfPool > 0 ? "<0.1%" : `${pctOfPool.toFixed(pctOfPool >= 10 ? 0 : 1)}%`}
                  </Td>
                  <Td align="right" color={remaining > 0 ? "#fff" : "rgba(255,255,255,0.4)"}>
                    {packOddsLabel(remaining, poolRemaining, slots)}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
        Odds/pack ≈ chance of at least one card of that tier across {slots && slots > 0 ? slots : "the"} slots, from the live remaining pool. Approximate (assumes independent slots).
      </div>
    </section>
  )
}

// ── Packs Content Remaining (Item 1) ────────────────────────────────────────
// Top Shot's drop pages lead with a "Packs Content Remaining" module: a ring of
// packs still unopened + per-tier remaining bars. RPC now has the same data
// (compute-topshot-pack-ev v20 persists remaining/original counts-by-tier +
// total_unopened/total_pack_count into pack_distributions.metadata). Renders
// only when there's a real indexed drop pool AND at least one of the two data
// sources (packs ring / tier bars) is present — never fabricates bars on a
// no-pool pack (same gate as TierOddsPanel, Pack 1b).

function PacksContentRemaining({
  unopened,
  totalMinted,
  remainingByTier,
  originalByTier,
  updatedAt,
  hasDropPool,
  tierAccent,
}: {
  unopened: number | null
  totalMinted: number | null
  remainingByTier: Record<string, number> | null
  originalByTier: Record<string, number> | null
  updatedAt: string | null
  hasDropPool: boolean
  tierAccent: string
}) {
  if (!hasDropPool) return null
  const hasRing = totalMinted != null && totalMinted > 0 && unopened != null
  const hasBars = !!remainingByTier && !!originalByTier
  if (!hasRing && !hasBars) return null

  // Donut: fraction of minted packs still unopened. conic-gradient ring with a
  // hollow center label, no chart lib (the artifact-brand-CSS pattern).
  const unopenedPct = hasRing ? Math.max(0, Math.min(100, (unopened! / totalMinted!) * 100)) : null
  const ring = unopenedPct != null
    ? `conic-gradient(${tierAccent} 0 ${unopenedPct}%, rgba(255,255,255,0.08) ${unopenedPct}% 100%)`
    : undefined

  const tiers = hasBars
    ? (() => {
        const present = TIER_RARITY_ORDER.filter((t) => Number(originalByTier![t] ?? 0) > 0)
        for (const k of Object.keys(originalByTier!)) {
          if (!TIER_RARITY_ORDER.includes(k) && Number(originalByTier![k] ?? 0) > 0) present.push(k)
        }
        return present
      })()
    : []

  return (
    <section
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          Packs Content Remaining
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          live pool{updatedAt ? ` · as of ${relTimeShort(updatedAt)}` : ""}
        </span>
      </div>

      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
        {ring && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flex: "0 0 auto" }}>
            <div
              style={{
                position: "relative",
                width: 132,
                height: 132,
                borderRadius: "50%",
                background: ring,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  width: 92,
                  height: 92,
                  borderRadius: "50%",
                  background: "rgba(13,13,13,0.98)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2,
                }}
              >
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, color: "#fff", lineHeight: 1 }}>
                  {unopenedPct!.toFixed(unopenedPct! >= 10 ? 0 : 1)}%
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
                  unopened
                </span>
              </div>
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
              {fmtCount(unopened)} / {fmtCount(totalMinted)} packs
            </span>
          </div>
        )}

        {tiers.length > 0 && (
          <div style={{ flex: "1 1 280px", minWidth: 240, display: "flex", flexDirection: "column", gap: 10 }}>
            {tiers.map((t) => {
              const remaining = Number(remainingByTier![t] ?? 0)
              const original = Number(originalByTier![t] ?? 0)
              const pct = original > 0 ? Math.max(0, Math.min(100, (remaining / original) * 100)) : 0
              const chip = tierChip(t)
              return (
                <div key={t}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: chip.color, letterSpacing: "0.04em", textTransform: "uppercase", fontWeight: 700 }}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.7)" }}>
                      {remaining.toLocaleString()} <span style={{ color: "rgba(255,255,255,0.4)" }}>/ {original.toLocaleString()} ({pct.toFixed(pct >= 10 ? 0 : 1)}%)</span>
                    </span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: chip.color, borderRadius: 4 }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

// ── Pack Sales History (Item 2) ─────────────────────────────────────────────
// Top Purchases (highest price) + Recent Purchases (newest). Buyer renders as a
// short wallet linking to /analytics/wallets/<addr> — the differentiator over
// Top Shot's own drop page, where the buyer is a dead-end name. Coverage is
// partial (the dist bridge only links sales whose pack was later opened), so
// the module carries an explicit caption and an honest empty state.

function fmtSalePrice(v: string | number | null): string {
  const n = v == null ? null : Number(v)
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

function ShortWallet({ address }: { address: string | null }) {
  if (!address) return <span style={{ color: "rgba(255,255,255,0.4)" }}>—</span>
  const trunc = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
  return (
    <Link
      href={`/analytics/wallets/${address.toLowerCase()}`}
      title={address}
      style={{ color: "#fff", textDecoration: "none", borderBottom: "1px dotted rgba(255,255,255,0.25)" }}
    >
      {trunc}
    </Link>
  )
}

function PackSalesTable({ title, rows }: { title: string; rows: PackSaleRow[] }) {
  return (
    <div style={{ flex: "1 1 320px", minWidth: 280 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
              <Th>Buyer</Th>
              <Th align="right">Sale price</Th>
              <Th align="right">When</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={`${s.tx_hash ?? i}-${title}`} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <Td><ShortWallet address={s.buyer_address} /></Td>
                <Td align="right">{fmtSalePrice(s.sale_price)}</Td>
                <Td align="right" color="rgba(255,255,255,0.55)">
                  <span title={s.sealed_at ? new Date(s.sealed_at).toLocaleString() : undefined}>{relTimeShort(s.sealed_at)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PackSalesHistory({ rows }: { rows: PackSaleRow[] }) {
  const top = rows.filter((r) => r.kind === "top")
  const recent = rows.filter((r) => r.kind === "recent")

  return (
    <section
      style={{
        background: "rgba(13,13,13,0.92)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        padding: 18,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          Sales History
        </h2>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          secondary pack sales
        </span>
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)", marginBottom: 14 }}>
        Traced via opened packs — partial coverage that grows over time. Buyer links open the wallet&apos;s full intelligence.
      </div>

      {rows.length === 0 ? (
        <div
          style={{
            padding: "12px 14px",
            border: "1px dashed rgba(255,255,255,0.1)",
            borderRadius: 6,
            color: "rgba(255,255,255,0.4)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          No traced sales yet for this pack.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          {top.length > 0 && <PackSalesTable title="Top purchases" rows={top} />}
          {recent.length > 0 && <PackSalesTable title="Recent purchases" rows={recent} />}
        </div>
      )}
    </section>
  )
}
