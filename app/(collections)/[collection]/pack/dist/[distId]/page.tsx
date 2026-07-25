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
import { Suspense } from "react"
import { topshotPackUrl, dapperMarketPackUrl } from "@/lib/pack-urls"
import Link from "next/link"
import { notFound } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { resolveUsernames } from "@/lib/flowty-username"
import PackHeroArt from "@/components/packs/PackHeroArt"
// tierChip moved to lib/tier-style.ts so this server component can call it;
// the version exported from PackTable.tsx ('use client') would throw at
// runtime — that's the bug this page was hitting before 2026-05-26.
import { tierChip } from "@/lib/tier-style"
import PackShareButton from "@/components/packs/PackShareButton"
import PackContentsFallback from "@/components/packs/PackContentsFallback"
import TrackedOutboundLink from "@/components/TrackedOutboundLink"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"
import Breadcrumbs from "@/components/entity/Breadcrumbs"
import { packJsonLd } from "@/lib/seo"
import { humanizeLabel } from "@/lib/format"

export const revalidate = 600
export const dynamicParams = true

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(13,13,13,0.92)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 18,
}

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
  // Typical Pull EV = slots × weighted-MEDIAN moment FMV over the remaining pool
  // (vs gross_ev = weighted MEAN = "Actual EV"). Sits near the common floor;
  // the gap gross_ev − typical_ev is the "grail premium" (lottery shape).
  // NULL when the pool is incomplete/sentinel — same as gross_ev.
  typical_ev: string | number | null
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

// ── Observed pack lifecycle (Top Shot only) ──────────────────────────────────
// pack_distributions.total_minted/total_opened/total_sealed/depletion_pct are
// dead (all zero for every TS dist), so the cached view's counters are useless.
// v_topshot_pack_lifecycle carries the real, honest numbers derived from
// pack_rips + the rip→dist attribution table. These are OBSERVED (since
// Apr 2026), not all-time-minted — labelled as such in the UI.
interface PackLifecycleRow {
  packs_opened: string | number | null
  packs_opened_confirmed: string | number | null
  packs_opened_inferred: string | number | null
  packs_sealed_observed: string | number | null
  moments_pulled: string | number | null
  realized_pull_value_usd: string | number | null
  avg_realized_value_per_pack: string | number | null
  observed_depletion_pct: string | number | null
}

// Modeled-EV-vs-realized-pull reality check (Top Shot only). The view filters
// to dists with >= 10 attributed opens so the realized distribution is stable.
interface PackRealizedEvRow {
  modeled_gross_ev: string | number | null
  n_opens: string | number | null
  realized_mean: string | number | null
  realized_median: string | number | null
  realized_p90: string | number | null
  realized_to_modeled_ratio: string | number | null
  // calibrated_ev = confidence-weighted blend of modeled gross EV and the realized
  // pull mean (Item 2 calibrate). Non-destructive: the canonical gross_ev stays raw.
  calibrated_ev: string | number | null
}

async function fetchPackLifecycle(collectionSlug: string, distId: string): Promise<PackLifecycleRow | null> {
  // AllDay reaches parity via v_allday_pack_lifecycle (pack-OPEN events ingested
  // since ~Jun 2026 + on-chain pull-edition resolution). Its columns differ from
  // the TS view — no confirmed/inferred split (every AllDay open is on-chain
  // confirmed) and depletion is opened_pct_of_minted — so map it into the shared
  // PackLifecycleRow shape. Per-dist rows are sparse while resolve-allday-pack-dist
  // grinds the mint era; dists with no attributed opens just return packs_opened 0
  // → the strip self-hides (showLifecycle gate).
  if (collectionSlug === "nfl-all-day") {
    const { data, error } = await sb
      .from("v_allday_pack_lifecycle")
      .select("packs_opened, minted, moments_pulled, realized_pull_value_usd, avg_realized_value_per_pack, opened_pct_of_minted")
      .eq("dist_id", distId)
      .maybeSingle()
    if (error) {
      console.error("[pack-detail] allday_pack_lifecycle error", error.message)
      return null
    }
    if (!data) return null
    return {
      packs_opened: data.packs_opened ?? null,
      packs_opened_confirmed: data.packs_opened ?? null, // all on-chain confirmed
      packs_opened_inferred: 0,
      // Sealed = minted - opened (the registry knows the full mint; honest
      // "unopened" figure — was previously null, hiding the sealed count).
      packs_sealed_observed:
        data.minted != null && data.packs_opened != null && Number(data.minted) >= Number(data.packs_opened)
          ? Number(data.minted) - Number(data.packs_opened)
          : null,
      moments_pulled: data.moments_pulled ?? null,
      realized_pull_value_usd: data.realized_pull_value_usd ?? null,
      avg_realized_value_per_pack: data.avg_realized_value_per_pack ?? null,
      observed_depletion_pct: data.opened_pct_of_minted ?? null,
    }
  }
  if (collectionSlug !== "nba-top-shot") return null
  // Per-dist SECDEF RPC (2026-07-16): v_topshot_pack_lifecycle aggregates ALL
  // pack_rips + attribution + pack_purchases before the dist filter (~48s under
  // load — one 30s service-role statement timeout per page view). Same cure as
  // get_pack_market_row; the view stays for board consumers.
  const { data, error } = await sb
    .rpc("get_pack_lifecycle_row", { p_dist_id: distId })
    .maybeSingle()
  if (error) {
    console.error("[pack-detail] pack_lifecycle error", error.message)
    return null
  }
  return (data as PackLifecycleRow | null) ?? null
}

async function fetchPackRealizedEv(collectionSlug: string, distId: string): Promise<PackRealizedEvRow | null> {
  // AllDay reality-check via v_allday_pack_realized_ev (modeled corrected EV vs
  // observed realized pulls). No p90 / calibrated_ev columns — map into the shared
  // shape with nulls. Currently 0 rows until a paid dist ∩ opened overlap exists.
  if (collectionSlug === "nfl-all-day") {
    const { data, error } = await sb
      .from("v_allday_pack_realized_ev")
      .select("modeled_gross_ev, n_opens, realized_mean, realized_median, realized_to_modeled_ratio")
      .eq("dist_id", distId)
      .maybeSingle()
    if (error) {
      console.error("[pack-detail] allday_pack_realized_ev error", error.message)
      return null
    }
    if (!data) return null
    return {
      modeled_gross_ev: data.modeled_gross_ev ?? null,
      n_opens: data.n_opens ?? null,
      realized_mean: data.realized_mean ?? null,
      realized_median: data.realized_median ?? null,
      realized_p90: null,
      realized_to_modeled_ratio: data.realized_to_modeled_ratio ?? null,
      calibrated_ev: null,
    }
  }
  if (collectionSlug !== "nba-top-shot") return null
  // Per-dist SECDEF RPC (2026-07-16): v_topshot_pack_realized_ev aggregates the
  // whole attribution table per lookup (~24s under load). Identical columns.
  const { data, error } = await sb
    .rpc("get_pack_realized_ev_row", { p_dist_id: distId })
    .maybeSingle()
  if (error) {
    console.error("[pack-detail] pack_realized_ev error", error.message)
    return null
  }
  return (data as PackRealizedEvRow | null) ?? null
}

// NFL All Day corrected EV (AllDay only). The canonical headline AllDay EV
// (compute_pack_ev_per_edition_weighted, edge fn v8) is now a per-edition
// SUPPLY-weighted mean(fmv) × slots — each edition weighted by its circulation
// share, so low-supply rares no longer count as much as commons. This corrected
// EV is a robust cross-check: it values each tier by its MEDIAN FMV (resistant to
// per-edition FMV outliers) and weights tiers by pull probability (published
// packOdds where we captured them, else circulation share). Surfaced with the
// low_confidence_ev caveat, mirroring the TS calibrated reality-check adoption pattern.
interface AllDayCorrectedEvRow {
  corrected_gross_ev: string | number | null
  corrected_net_ev: string | number | null
  corrected_value_ratio: string | number | null
  ev_method: string | null
  has_published_odds: boolean | null
  stale_value_share_pct: string | number | null
  low_confidence_ev: boolean | null
  // Authoritative complete depletion (Dapper searchPackNft, all dists). Use this
  // for AllDay "% opened", not the rip-based v_allday_pack_lifecycle figure which
  // only covers ingested opens (2026-06-29 full-history pack data layer).
  opened_count: string | number | null
  packnft_total: string | number | null
  opened_pct_of_minted: string | number | null
}

async function fetchAllDayCorrectedEv(collectionSlug: string, distId: string): Promise<AllDayCorrectedEvRow | null> {
  if (collectionSlug !== "nfl-all-day") return null
  const { data, error } = await sb
    .from("v_allday_pack_info")
    .select("corrected_gross_ev, corrected_net_ev, corrected_value_ratio, ev_method, has_published_odds, stale_value_share_pct, low_confidence_ev, opened_count, packnft_total, opened_pct_of_minted")
    .eq("dist_id", distId)
    .maybeSingle()
  if (error) {
    console.error("[pack-detail] allday_corrected_ev error", error.message)
    return null
  }
  return (data as AllDayCorrectedEvRow | null) ?? null
}

// ── Secondary sealed-pack resale market (NFL All Day + Top Shot) ─────────────
// v_{allday,topshot}_pack_market roll up the complete sealed-pack secondary sale
// history (Dapper Studio Platform, backfilling to each collection's genesis) per
// dist: median / last / count + the premium-or-discount vs the original retail
// price. What a SEALED pack actually trades for — something Top Shot's own site
// never surfaces cleanly. Single-dist lookup is index-driven (~2-3ms). Both
// views share the same market columns, so one fetcher covers both.
interface PackMarketRow {
  n_sales: string | number | null
  n_sales_30d: string | number | null
  n_sales_90d: string | number | null
  last_sale_price: string | number | null
  last_sale_at: string | null
  avg_price_90d: string | number | null
  median_price_90d: string | number | null
  min_price_all: string | number | null
  max_price_all: string | number | null
  retail_price: string | number | null
  secondary_vs_retail_ratio: string | number | null
}

const PACK_MARKET_VIEW: Record<string, string> = {
  "nfl-all-day": "v_allday_pack_market",
  "nba-top-shot": "v_topshot_pack_market",
}

async function fetchPackMarket(collectionSlug: string, distId: string): Promise<PackMarketRow | null> {
  if (!PACK_MARKET_VIEW[collectionSlug]) return null
  // Per-dist SECDEF RPC (2026-07-14): the v_*_pack_market views aggregate the
  // entire *_pack_sales_history table (570k rows) before the dist filter can
  // apply (~26s under load — the smoke-failing tail of this page). The RPC
  // computes the same columns for one dist via idx_*_pack_sales_hist_dist.
  const { data, error } = await sb.rpc("get_pack_market_row", {
    p_collection_slug: collectionSlug,
    p_dist_id: distId,
  })
  if (error) {
    console.error(`[pack-detail] pack_market rpc error (${collectionSlug})`, error.message)
    return null
  }
  const row = Array.isArray(data) ? data[0] : data
  return (row as PackMarketRow | null) ?? null
}

// ── "What drives the remaining EV" (Top Shot only) ──────────────────────────
// get_pack_ev_contributors ranks the editions STILL in the drop pool by their
// per-slot EV contribution (pull_prob × FMV) as a share of the pack's per-slot
// expected value, each tagged with its FMV confidence. Surfaces how much of the
// headline EV leans on low-confidence chase prices — the honest read the raw
// Gross EV number hides.
interface EvContributor {
  edition_id: string
  external_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  fmv_usd: string | number | null
  confidence: string | null
  pull_prob: string | number | null
  ev_per_slot: string | number | null
  pct_of_ev: string | number | null
}

async function fetchEvContributors(collectionSlug: string, distId: string): Promise<EvContributor[]> {
  if (collectionSlug !== "nba-top-shot") return []
  const { data, error } = await sb.rpc("get_pack_ev_contributors", { p_dist_id: distId, p_limit: 12 })
  if (error) { console.error("[pack-detail] ev_contributors error", error.message); return [] }
  return Array.isArray(data) ? (data as EvContributor[]) : []
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
// Returns null on a LOAD FAILURE and [] for a genuinely empty pool. The caller
// renders different copy for each: collapsing both to [] silently deleted the
// whole "What's Inside" panel whenever the RPC errored, with nothing on screen
// to say so (the silent-failure class).
async function fetchPackContents(collectionId: string, distId: string, limit: number, offset: number): Promise<EditionTile[] | null> {
  const { data, error } = await sb.rpc("get_pack_contents", {
    p_collection_id: collectionId,
    p_dist_id: distId,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) { console.error("[pack-detail] get_pack_contents error", error.message); return null }
  return Array.isArray(data) ? (data as EditionTile[]) : []
}

// PACKVIZ-GRID 2a — the top-5-by-FMV "hero strip". get_pack_contents orders by
// EV-per-slot (FMV × drop_weight), so a high-FMV / low-weight chase card sorts
// far down its list — the headline pulls need their own FMV-ordered fetch.
// Top Shot legacy thumbnail_url (assets.nbatopshot.com/editions/…) 404s for
// Series 1-4 editions; the per-moment media/<nft_id>/image form works for every
// TS moment, so prefer it when a representative nft_id is available (Item 1,
// 2026-06-22 audit). Server-rendered surfaces have no onError fallback, so this
// returns the single best URL.
function tsTileImg(
  collectionSlug: string,
  repNftId: string | null | undefined,
  thumbnailUrl: string | null | undefined,
): string | null {
  if (collectionSlug === "nba-top-shot" && repNftId && /^\d+$/.test(repNftId)) {
    return `https://assets.nbatopshot.com/media/${repNftId}/image?width=400`
  }
  return thumbnailUrl ?? null
}

interface HeroEdition {
  route_slug: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  thumbnail_url: string | null
  rep_nft_id: string | null
  fmv_usd: number | null
  hit_probability: number | null
}

// Hero editions (top-5 by FMV) now come from get_pack_detail_bundle in the shell
// (P3) — the standalone fetch was retired to keep it on the single bundle RPC.

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

// Per-edition EV is FMV × pull-odds × slots, so a low-odds common can be a real
// positive value that rounds to $0.00 (e.g. $2.29 × 0.02% → $0.0005). Showing
// "$0.00" next to a live FMV reads like missing data — surface "<$0.01" instead
// (Pack G). Zero / null / negative fall through to the standard formatter.
function fmtUsdEv(v: number | null | undefined): string {
  if (v !== null && v !== undefined && Number.isFinite(v) && v > 0 && v < 0.005) return "<$0.01"
  return fmtUsd(v)
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return `${v.toFixed(1)}%`
}

function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—"
  return v.toLocaleString()
}

function fmtAgo(iso: string | null | undefined): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const days = Math.max(0, Math.round((Date.now() - then) / 86400000))
  if (days < 1) return "today"
  if (days === 1) return "yesterday"
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.round(days / 365)}y ago`
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
  const tierLabel = row?.tier ? humanizeLabel(String(row.tier)) : ""
  const metaTitle = `${title}${tierLabel ? ` — ${tierLabel}` : ""} | ${coll.displayName} | Rip Packs City`
  // AllDay: prefer the odds/median-corrected EV (matches the page headline) so
  // the SEO description never advertises the inflated canonical number.
  const correctedEv = await fetchAllDayCorrectedEv(collection, distId)
  const useCorrectedEv = correctedEv != null && correctedEv.corrected_gross_ev != null
  const grossEv = useCorrectedEv ? num(correctedEv!.corrected_gross_ev) : num(row?.gross_ev ?? null)
  const price = num(row?.retail_price_usd ?? null)
  // Holding/escrow packs carry sentinel prices ($9,999/$99,999/$999,999) — keep
  // them out of the SEO description so it doesn't advertise a $900K "Gross EV".
  const sentinelPrices = new Set([9999, 99999, 999999])
  const isHoldingPack = /\bhold(?:ing|er)?\b/i.test(title) || (price !== null && sentinelPrices.has(price))
  // Never advertise a survivor-biased pull-value EV in the SEO description. A
  // depleted TS pack's drop pool retains only its rare chases, inflating the raw
  // gross EV 40–86× (e.g. dist 5223: "Gross EV $801 · 80x" on a $10 pack). Drop
  // the EV + value-ratio sentences when the pool is ≥90% depleted or the gross EV
  // exceeds 3× a live secondary ask. AllDay already substitutes the odds-corrected
  // number above (useCorrectedEv), so this guards only the raw TS path. Mirrors
  // the page's evSurvivorBiased gate. See [[pack-ev-view-dataquality-footguns]].
  const evDepPct = num(row?.ev_depletion_pct ?? null)
  const secAsk = num(row?.secondary_ask ?? null)
  const seoSurvivorBiased = !useCorrectedEv && (
    (evDepPct !== null && evDepPct >= 90) ||
    (row?.secondary_available === true && secAsk !== null && secAsk > 0 && grossEv !== null && grossEv > 3 * secAsk)
  )
  const descParts = [
    `${title} on ${coll.displayName}.`,
    !isHoldingPack && price !== null ? `Retail ${fmtUsd(price)}.` : null,
    !isHoldingPack && !seoSurvivorBiased && grossEv !== null ? `Value still sealed ≈ ${fmtUsd(grossEv)}.` : null,
    "Pack EV vs live secondary ask, top pulls, and depletion based on Rip Packs City's cached snapshot.",
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

  // P3: one-RPC shell bundle (pack_row + dist_fallback + AllDay corrected_ev +
  // top-5 FMV hero editions + has_pool) on ONE connection, replacing the prior
  // 10-way per-request Promise.all fan-out that saturated the connection pool
  // (~58 statement-timeouts/24h). The heavy below-the-fold sections now
  // Suspense-stream on their own connections, off the critical path.
  // rpcWithRetry: the shell bundle is the throw-or-404 gate, so retry
  // connection-class errors (incl. "Timed out acquiring connection from
  // connection pool") in-process before surfacing — a transient pool blip no
  // longer flips a real dist to the retryable error boundary on the first miss.
  const { data: bundleData, error: bundleErr } = await rpcWithRetry(sb, "get_pack_detail_bundle", {
    p_collection_id: coll.id,
    p_dist_id: distId,
    p_collection_slug: collection,
  })
  if (bundleErr) console.error("[pack-detail] bundle error", bundleErr.message)
  const bundle = (bundleData ?? {}) as {
    pack_row: PackTableRow | null
    dist_fallback: DistFallbackRow | null
    corrected_ev: AllDayCorrectedEvRow | null
    hero_editions: HeroEdition[] | null
    has_pool: boolean | null
  }
  const row = bundle.pack_row ?? null
  const fallback = bundle.dist_fallback ?? null
  if (!row && !fallback) {
    // Distinguish "this dist does not exist" from "the bundle RPC failed"
    // (statement timeout under contention). The latter was rendering real
    // packs as 404s intermittently — throw instead so the error boundary
    // shows a retryable state and crawlers never see not-found for a real dist.
    if (bundleErr) throw new Error(`pack detail bundle unavailable: ${bundleErr.message}`)
    notFound()
  }

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
    typical_ev: null,
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

  const distMetadata = fallback?.metadata ?? null

  // From the shell bundle: AllDay corrected EV (shell-critical — overrides the
  // headline EV), the top-5 FMV hero editions (montage fallback + hero strip),
  // and whether a real drop pool exists. Everything else streams below.
  const correctedEv: AllDayCorrectedEvRow | null = bundle.corrected_ev ?? null
  const heroEditions: HeroEdition[] = Array.isArray(bundle.hero_editions) ? bundle.hero_editions : []
  const hasPoolFromBundle = bundle.has_pool === true

  // Defensive: pack_table_rows.tier is typed string|null but coerce in case
  // the view ever returns a non-string. Same for title.
  const tier = String(merged.tier ?? "common").toLowerCase()
  const chip = tierChip(tier)
  const tierAccent = chip.color
  const title = String(merged.title ?? "Pack")
  // Canonical EV from pack_table_rows (← pack_ev_latest). For AllDay this is the
  // flat-trimmed-mean number that ignores pull odds; prefer the corrected EV below.
  const grossEvRaw = num(merged.gross_ev)
  const packEvRaw = num(merged.pack_ev)
  // AllDay: substitute the odds/median-robust corrected GROSS EV (v_allday_pack_info)
  // at the source so every downstream render site (KPI grid, pct-vs-ask callout,
  // verdict, SEO) uses the corrected sealed-value number. The net/ratio verdict
  // itself is then computed uniformly against the live secondary ask below.
  const useCorrectedEv =
    collection === "nfl-all-day" && correctedEv != null && correctedEv.corrected_gross_ev != null
  // Gross EV = value of the moments still sealed. AllDay substitutes the
  // odds/median-robust corrected gross so every downstream site uses it. The
  // NET/ratio/margin verdict is derived lower down against the live secondary
  // ask ONLY (never retail/primary) — see secondaryAskAnchor below.
  const grossEv = useCorrectedEv ? num(correctedEv!.corrected_gross_ev) : grossEvRaw
  // Typical Pull EV (2026-07-16) — slots × weighted-MEDIAN moment value over the
  // remaining pool. Where Actual EV (grossEv, the weighted MEAN) swings as grails
  // deplete, Typical Pull sits near the common floor and barely moves; the gap is
  // the "grail premium" — how lottery-shaped the pack is. TS-only remaining-pool
  // stat (Atlas-harvested or genuinely complete pools); the AllDay/Pinnacle
  // corrected-EV substitution does NOT carry it, so leave it as the raw column and
  // don't surface it when the AllDay corrected override is in play.
  const typicalEv = useCorrectedEv ? null : num(merged.typical_ev)
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
  // ── Verdict anchor (2026-07-07 reframe) ─────────────────────────────────
  // Pack EV compares the value of the moments STILL SEALED (grossEv) ONLY to
  // the live secondary sealed-pack low ask — what the pack itself actually
  // resells for. Primary/retail price is irrelevant to that question. When
  // there's no live secondary ask we show Gross EV informationally but render
  // NO net/ratio/positive-EV verdict. secondaryAsk/secondaryAvailable derive
  // from the same Dapper Studio aggregation as pack_ask_state.lowest_ask.
  const secondaryAskAnchor = secondaryAvailable && secondaryAsk != null && secondaryAsk > 0 ? secondaryAsk : null
  const packEv = grossEv != null && secondaryAskAnchor != null
    ? Math.round((grossEv - secondaryAskAnchor) * 100) / 100 : null
  const valueRatio = grossEv != null && secondaryAskAnchor != null
    ? grossEv / secondaryAskAnchor : null
  const evMargin = valueRatio != null ? (valueRatio - 1) * 100 : null
  // livePrice is retained ONLY as a display / sentinel-detection price (the KPI
  // price tile, holding-pack sentinel, buy payload) — never as a verdict anchor.
  const livePrice =
    priceSource === "primary" ? primaryPrice
    : priceSource === "secondary" ? secondaryAsk
    : priceSource === "min" ? primaryPrice
    : evPackPrice ?? retailPrice
  const isPositive = packEv != null && packEv > 0
  const snapshottedAt = merged.ev_snapshotted_at
  // Reward / quest packs ship with retail_price_usd = 0 (Pack D1). Value-ratio
  // and EV-margin verdicts divide by retail, so they produce garbage on free
  // packs — gate them off and surface a "Reward pack" badge instead.
  const isRewardPack = retailPrice === 0
  // Holding / Holder / Hold packs (chiefly NFL All Day) are escrow/placeholder
  // constructs, not consumer packs — they carry sentinel prices ($9,999 /
  // $99,999 / $999,999) that produce nonsense verdicts ($900K "Gross EV", 3%
  // coverage). Detect by name or sentinel price and suppress the price + EV
  // verdict, mirroring the reward-pack handling. (Item 4, 2026-06-22 audit.)
  const SENTINEL_PRICES = new Set([9999, 99999, 999999])
  // pack_ev is clamped to the pack_ev_latest view's -10000 floor when pack_price
  // dwarfs gross_ev by >$10k — the unambiguous signature of an escrow/whale/holding
  // construct (a real consumer pack never clears a $10k price-vs-EV gap), even when
  // its sentinel price isn't one of the canonical 9999/99999/999999 values (e.g.
  // dists priced $18k/$40k/$200k). Treat it as a holding pack so the clamped
  // "-$10,000.00" never renders as a literal Net. (Item 11, 2026-06-26 audit.)
  // Holding-pack detection always reads the CANONICAL net (packEvRaw) so the
  // AllDay corrected override can't mask a clamped escrow sentinel.
  const isClampedEv = packEvRaw !== null && packEvRaw <= -10000
  const isHoldingPack =
    /\bhold(?:ing|er)?\b/i.test(title) ||
    isClampedEv ||
    (retailPrice !== null && SENTINEL_PRICES.has(retailPrice)) ||
    (livePrice !== null && SENTINEL_PRICES.has(livePrice))
  // Verdict renders ONLY when there is a live secondary ask to compare against
  // (2026-07-07 reframe). No ask → Gross EV shows, but no net/ratio/positive-EV.
  const showPriceVerdict = !isRewardPack && !isHoldingPack && secondaryAskAnchor != null
  // Prices fed to the KPI block; suppressed for holding packs so the card shows
  // "—" instead of a $999,999 sentinel.
  const displayLivePrice = isHoldingPack ? null : livePrice
  const displayRetailPrice = isHoldingPack ? null : retailPrice

  // Does this distribution have a real, indexed drop pool? Gates the
  // pull-odds-by-tier panel (which otherwise renders pack-count-by-tier as if
  // it were pool entries on no-pool packs — Pack 1b) and the EV-sentinel
  // honesty path (Pack 1c).
  const hasDropPool = hasPoolFromBundle || (editionCount != null && editionCount > 0)

  // 1c — A no-pool pack's latest EV row is a sentinel (edition_count 0 /
  // fmv_coverage null|0). Rendering "$0.00 Gross EV / Net +$0.00" reads as
  // "this pack is worthless" and contradicts the empty state below; show an
  // em-dash + "awaiting pool data" and suppress the Net line instead.
  const isSentinelEv = !hasDropPool && ((editionCount ?? 0) === 0 || !fmvCoverage)

  // Typical Pull display: show whenever the complete-pool median EV is present and
  // the pack isn't a holding/sentinel construct. Unlike Actual EV, it stays honest
  // even on depleted pools (it IS the common-floor number), so it is NOT blanked by
  // the survivor-bias gate. Grail premium = Actual − Typical: only surfaced as a
  // "lottery" chip when the gap is a meaningful share of Actual EV (≥15% and ≥$0.50).
  const showTypicalPull = typicalEv != null && !isHoldingPack && !isSentinelEv
  const grailPremium =
    showTypicalPull && grossEv != null && grossEv > typicalEv!
      ? Math.round((grossEv - typicalEv!) * 100) / 100
      : null
  const isLotteryShaped =
    grailPremium != null && grossEv != null && grossEv > 0 &&
    grailPremium >= 0.5 && grailPremium >= 0.15 * grossEv

  // 1f — Hero montage fallback: top-4-by-FMV pool thumbnails, used by
  // PackHeroArt when the pack's own image_url is dead/missing. Prefer the
  // working media/<nft_id>/image form for Top Shot (legacy editions/ thumbnails
  // 404 — Item 1, 2026-06-22 audit).
  // Hero montage fallback: top-4 by FMV from the bundle's hero editions (already
  // FMV-desc). Prefer the working media/<nft_id>/image form for Top Shot.
  const montageThumbs = heroEditions
    .map((e) => tsTileImg(collection, e.rep_nft_id, e.thumbnail_url))
    .filter((u): u is string => !!u)
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

  // AllDay: the v20 tier-count metadata (total_pack_count / total_unopened) is
  // dead-by-design — AllDay mints on demand and RPC never ran the historical
  // PackNFT.Mint walk, so those counters read 0 for every AllDay dist and the
  // pack-content counts render blank/hidden. The authoritative complete mint +
  // opened counts live in v_allday_pack_info (Dapper searchPackNft full-history)
  // — the SAME source the depletion % above already reads (opened_pct_of_minted,
  // passed to the observed-lifecycle strip) — and arrive on the shell bundle as
  // correctedEv. Reconciliation verified live: opened_count <= packnft_total for
  // all AllDay dists (0 violations). Source the counts from it so opened /
  // unopened / total render real numbers.
  const allDayTotalMinted = collection === "nfl-all-day" ? num(correctedEv?.packnft_total) : null
  const allDayOpened = collection === "nfl-all-day" ? num(correctedEv?.opened_count) : null
  const allDayUnopened =
    allDayTotalMinted != null && allDayOpened != null
      ? Math.max(0, allDayTotalMinted - allDayOpened)
      : null
  // Effective figures for the KPI grid + PacksContentRemaining ring: the AllDay
  // authoritative counts win, else the v20 metadata (Top Shot's working path).
  const effectiveTotalMinted = allDayTotalMinted ?? metaTotalPackCount
  const effectiveUnopened = allDayUnopened ?? liveUnopened

  // 2a — Depletion: prefer the v20 metadata-derived figure, fall back to the cached
  // depletion_pct, and HIDE the tile entirely when neither source exists (never 0%).
  const depletionPct: number | null = (() => {
    if (metaTotalPackCount && metaTotalPackCount > 0 && metaTotalUnopened != null) {
      return Math.max(0, Math.min(100, ((metaTotalPackCount - metaTotalUnopened) / metaTotalPackCount) * 100))
    }
    return depletion != null ? Number(depletion) : null
  })()

  // Display-only depletion for the top "Depletion" KPI. AllDay's packs-opened
  // metadata is dead (reads 0), so without this the tile shows a false "0.0%"
  // right beside the authoritative counts + the 89%-opened lifecycle strip.
  // Use the same v_allday_pack_info figure (opened_pct_of_minted, else
  // opened/total). Deliberately SEPARATE from depletionPct so it does NOT feed
  // poolDepletionPct below — that survivor-bias gate must stay pool-based, not
  // packs-opened-based.
  const displayDepletionPct: number | null =
    collection === "nfl-all-day"
      ? (num(correctedEv?.opened_pct_of_minted) != null
          ? Math.max(0, Math.min(100, num(correctedEv?.opened_pct_of_minted)!))
          : allDayTotalMinted != null && allDayTotalMinted > 0 && allDayOpened != null
            ? Math.max(0, Math.min(100, (allDayOpened / allDayTotalMinted) * 100))
            : null)
      : depletionPct

  // Pool depletion (% of the drop pool's editions exhausted) is the figure the
  // pull-value EV is computed against, and the one that drives survivor bias.
  // It is distinct from depletionPct above (% of PACKS opened) — for dists with
  // no pack-open tracking (total_minted/opened = 0) depletionPct reads 0 while
  // the pool is in fact heavily drained, so the survivor-bias caveat must read
  // ev_depletion_pct (straight from pack_ev_latest) or it self-contradicts.
  const poolDepletionPct: number | null =
    merged.ev_depletion_pct != null ? Number(merged.ev_depletion_pct) : depletionPct

  // 2d — EV verdict coverage gate: below 80% FMV coverage the EV is a lower bound,
  // not an authoritative verdict — render it neutral (no red/green) with a caveat.
  const COVERAGE_FLOOR = 80
  const coverageOk = fmvCoverage != null && fmvCoverage >= COVERAGE_FLOOR

  // Item 4 (2026-06-09) — secondary-ask reality check. Pull-value EV is computed
  // over the REMAINING pool, so as a pack sells through (cheap commons exhaust)
  // the surviving chases inflate EV far above what the pack honestly contains. A
  // pack freely listed on secondary for $X can't contain 3×$X of pulls — when it
  // appears to, or the pool is mostly opened, the EV is survivor-biased: render it
  // neutral and surface the secondary ask as the honest value estimate.
  const evInflatedVsAsk = secondaryAvailable && secondaryAsk != null && secondaryAsk > 0
    && grossEv != null && grossEv > 3 * secondaryAsk
  const poolMostlyOpened = poolDepletionPct != null && poolDepletionPct >= 60
  const evUnreliable = showPriceVerdict && (evInflatedVsAsk || poolMostlyOpened)

  const showColoredVerdict = showPriceVerdict && coverageOk && !evUnreliable
  // Egregious survivor bias — the pull-value EV is not merely uncertain but
  // structurally impossible to headline. A depleted TS pack's drop pool retains
  // only the rare chases (packEditionsV3 drops the common tier once sold out —
  // e.g. dist 5223 pools 80 Legendary/Rare editions and ZERO of its 47,300
  // commons), so mean(pooled FMV) overstates a real pull 40–86×. Blank the
  // headline Gross EV / Value-ratio numbers (relegate to a muted "ceiling"
  // caveat) rather than lead with "$801 · 80x · +EV" on a $10 pack. Two triggers:
  // pool ≥90% depleted, or gross EV > 3× a live secondary ask (a number a freely
  // resellable sealed pack provably can't contain). Scoped to the raw TS
  // pull-value path — AllDay's odds-corrected EV carries its own low_confidence
  // caveat and must not be blanked here. See [[pack-ev-view-dataquality-footguns]].
  const evSurvivorBiased = !useCorrectedEv && hasDropPool && (
    (poolDepletionPct != null && poolDepletionPct >= 90) || evInflatedVsAsk
  )
  const coverageCaveat: string | null = (() => {
    if (evUnreliable) {
      const honest = secondaryAvailable && secondaryAsk != null && secondaryAsk > 0
        ? ` honest value ≈ secondary ask ${fmtUsd(secondaryAsk)}`
        : " treat as a ceiling"
      const opened = poolDepletionPct != null ? `${Math.round(poolDepletionPct)}% depleted` : "heavily depleted"
      return `EV inflated by survivor bias (${opened}) —${honest}`
    }
    if (showPriceVerdict && !coverageOk && fmvCoverage != null) {
      return `${fmvCoverage}% FMV cov — EV is a floor`
    }
    return null
  })()

  // One-line summary above the KPI grid. Names the EV anchor explicitly so
  // the user knows whether the verdict is computed against retail or P2P ask.
  // priceSource = 'none' suppresses the verdict entirely.
  const evAnchorSummary: string | null = (() => {
    if (isRewardPack) return "Reward pack — distributed for free, no price-based verdict."
    if (isHoldingPack) return null
    if (secondaryAskAnchor != null) {
      return `Pack EV computed against the live secondary ask [${fmtUsd(secondaryAskAnchor)}] — what a sealed pack actually resells for, the only honest anchor for its value.`
    }
    return "No live secondary ask — showing Gross EV (value still sealed) only, with no net/ratio verdict."
  })()

  // Top Shot pack deep link — nbatopshot.com/?packDetail=<distId> opens the pack
  // detail modal (odds, contents, live "Buy from Market" button) for exactly this
  // dist, including sold-out / legacy drops (verified 2026-07-06). Pack audit S2:
  // suppress the buy CTA on reward packs and when the EV cron determined the pack
  // isn't currently for sale (price_source = "none").
  const buyUrl = collection === "nba-top-shot" && !isRewardPack && priceSource !== "none"
    ? topshotPackUrl({ distId })
    : null
  const buyCtaLabel = priceSource === "primary" || priceSource === "min"
    ? "Buy primary"
    : priceSource === "secondary"
      ? "Buy on secondary market"
      : "Buy on Top Shot"
  // dapper.market per-pack deep link (?packDetail=<distId>) — opens the exact
  // pack's detail modal with a live "Buy Pack" button (verified 2026-07-06). NBA
  // + NFL only; other collections have no packs on dapper.market. Suppressed on
  // reward packs.
  const dapperLeague: "nba" | "nfl" | null =
    collection === "nba-top-shot" ? "nba" : collection === "nfl-all-day" ? "nfl" : null
  const dapperPackUrl = !isRewardPack && dapperLeague
    ? dapperMarketPackUrl({ league: dapperLeague, distId })
    : null

  const tierLabel = humanizeLabel(tier)
  // 7 — the pack_type chip is suppressed when it's just the generic "pack"
  // (it's redundant on a pack page, and rendered tight beside the tier chip it
  // read as "Fandompack"). Only show a meaningful type (box / case / bundle …).
  const rawPackType = String(merged.pack_type ?? "").trim()
  // humanizeLabel, not CSS `capitalize`: underscores aren't word boundaries, so
  // a raw `in_season_premium` rendered as the literal "In_season_premium" on the
  // Golazos pack pages (fixed 2026-07-25).
  const packTypeLabel = rawPackType.toLowerCase() === "pack" ? "" : humanizeLabel(rawPackType)
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
              {isPositive && grossEv !== null && showPriceVerdict && !evUnreliable && (
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
              {dapperPackUrl ? (
                <TrackedOutboundLink
                  href={dapperPackUrl}
                  payload={{
                    surface: "pack_dist",
                    destination: "dapper_market_packs",
                    setName: title,
                    tier,
                    fmv: null,
                    buyUrl: dapperPackUrl,
                  }}
                  style={{
                    display: "inline-block",
                    padding: "8px 16px",
                    background: "transparent",
                    color: "rgba(255,255,255,0.85)",
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontSize: 12,
                    borderRadius: 4,
                    border: "1px solid rgba(255,255,255,0.25)",
                    textDecoration: "none",
                  }}
                >
                  Buy on Dapper →
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

      {/* ── Value still sealed (headline: EV vs pack price) ──────────────── */}
      {/* Vaultopolis-style one-liner: the expected pull value still inside an
          unopened pack (Gross EV) framed against the live pack price. Reuses the
          same colored-verdict + survivor-bias gating as the KPI grid below, so a
          low-coverage / mostly-opened pack reads neutral with the caveat rather
          than over-claiming. Suppressed on reward/holding/no-anchor/no-pool packs. */}
      {showPriceVerdict && !evSurvivorBiased && grossEv !== null && secondaryAskAnchor !== null && secondaryAskAnchor > 0 && hasDropPool && (() => {
        const pctVsPrice = (grossEv / secondaryAskAnchor - 1) * 100
        const above = pctVsPrice >= 0
        const accent = showColoredVerdict
          ? (above ? "rgb(110,231,183)" : "rgb(248,113,113)")
          : "rgba(255,255,255,0.85)"
        const pctLabel = Math.abs(pctVsPrice) >= 1 ? `${Math.round(Math.abs(pctVsPrice))}` : Math.abs(pctVsPrice).toFixed(1)
        return (
          <section
            style={{
              background: "rgba(13,13,13,0.92)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderLeft: `3px solid ${accent}`,
              borderRadius: 6,
              padding: "12px 16px",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "baseline",
              gap: "4px 12px",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "rgba(255,255,255,0.45)",
              }}
            >
              Value still sealed
            </span>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, color: accent }}>
              ≈ {fmtUsd(grossEv)}
              <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.5)" }}>/pack</span>
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: accent }}>
              {above ? "▲" : "▼"} {pctLabel}% {above ? "above" : "below"} the {fmtUsd(secondaryAskAnchor)} secondary ask
            </span>
            {coverageCaveat ? (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                · {coverageCaveat}
              </span>
            ) : null}
            {/* Typical Pull framing — a typical pull is worth ~the median moment,
                well below the grail-inflated mean on lottery-shaped packs. */}
            {showTypicalPull && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.55)", width: "100%" }}>
                Typical pull ≈ {fmtUsd(typicalEv)}
                {isLotteryShaped ? ` · grail premium ${fmtUsd(grailPremium)} (lottery-shaped)` : " · value evenly spread"}
              </span>
            )}
          </section>
        )
      })()}

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
            color: isRewardPack || secondaryAskAnchor == null ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.75)",
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

      {/* ── Streamed group (P3): observed lifecycle · EV reality check · what
          drives the remaining EV · sealed-pack resale. Fetched off the shell
          critical path so the connection burst staggers and a slow section
          degrades to nothing instead of timing out the whole page. ── */}
      <Suspense fallback={null}>
        <PackStreamedTop
          collection={collection}
          distId={distId}
          authoritativeDepletionPct={collection === "nfl-all-day" ? num(correctedEv?.opened_pct_of_minted) : null}
        />
      </Suspense>

      {/* ── KPI grid ─────────────────────────────────────────────────────── */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <DualPriceKpi
          primaryPrice={primaryPrice}
          secondaryAsk={secondaryAsk}
          priceSource={priceSource}
          primaryAvailable={primaryAvailable}
          secondaryAvailable={secondaryAvailable}
          fallbackPrice={displayLivePrice}
          retailPrice={displayRetailPrice}
        />
        <KpiCell
          label="Actual EV"
          value={isSentinelEv || isHoldingPack || evSurvivorBiased ? "—" : fmtUsd(grossEv)}
          sub={isHoldingPack ? "Holding pack — not a consumer pack" : isSentinelEv ? "awaiting pool data" : isRewardPack ? "Reward pack — free, no secondary-ask verdict" : evSurvivorBiased ? `≈ ${fmtUsd(grossEv)} ceiling · ${coverageCaveat ?? `pool ${poolDepletionPct != null ? Math.round(poolDepletionPct) + "% depleted" : "heavily depleted"} — survivor-biased`}` : secondaryAskAnchor == null ? "Mean pull value · no live secondary ask" : coverageCaveat ? (packEv !== null ? `Net ${packEv >= 0 ? "+" : "−"}${fmtUsd(Math.abs(packEv))} vs ask · ${coverageCaveat}` : coverageCaveat) : packEv !== null ? `Mean pull · Net ${packEv >= 0 ? "+" : "−"}${fmtUsd(Math.abs(packEv))} vs ask` : undefined}
          color={isSentinelEv || isHoldingPack || evSurvivorBiased || !showColoredVerdict || packEv === null ? undefined : packEv >= 0 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        {/* Typical Pull EV (2026-07-16) — the value of a typical pull (weighted
            MEDIAN moment × slots), sitting near the common floor. Actual EV (mean)
            overstates lottery-shaped packs where a rare grail is the jackpot; this
            is what most pulls are actually worth. Rendered only where the complete
            pool gives us a real median (typical_ev NOT NULL). */}
        {showTypicalPull && (
          <KpiCell
            label="Typical Pull"
            value={fmtUsd(typicalEv)}
            sub={
              isLotteryShaped
                ? `Grail premium ${fmtUsd(grailPremium)} — lottery-shaped`
                : grailPremium != null && grailPremium > 0
                  ? `Grail premium ${fmtUsd(grailPremium)} — value evenly spread`
                  : "Median pull ≈ Actual EV — value evenly spread"
            }
          />
        )}
        <KpiCell
          label="Value ratio"
          value={!showPriceVerdict || valueRatio === null || evSurvivorBiased ? "—" : `${valueRatio.toFixed(2)}x`}
          sub={isHoldingPack ? "Holding pack — n/a" : isRewardPack ? "Free pack — n/a" : evSurvivorBiased ? (coverageCaveat ?? "survivor-biased — not meaningful") : priceSource === "none" ? undefined : coverageCaveat ? (evMargin === null ? coverageCaveat : `${fmtPct(evMargin)} margin · ${coverageCaveat}`) : evMargin === null ? undefined : `${fmtPct(evMargin)} margin`}
          color={evSurvivorBiased || !showColoredVerdict || valueRatio === null ? undefined : valueRatio >= 1 ? "rgb(110,231,183)" : "rgb(248,113,113)"}
        />
        <KpiCell
          label="FMV coverage"
          value={fmvCoverage === null ? "—" : `${fmvCoverage}%`}
          sub={editionCount === null ? undefined : `${editionCount} editions`}
        />
        {/* F4 (2026-07-02): reward/quest packs (retail=0) mint-on-demand, so their
            total_minted / total_opened / total_pack_count counters are dead-by-design
            (packs_opened runs ~6× the "minted" figure — e.g. dist 7800: 21k opened vs
            3,240 "minted"). The packs-opened Depletion and "Packs remaining / of N
            minted" KPIs read those dead counters and contradict the honest Observed
            pack lifecycle strip right below. Suppress them for reward packs rather than
            surface a wrong denominator (see [[pack-ev-view-dataquality-footguns]]). */}
        {displayDepletionPct !== null && !isRewardPack && (
          <KpiCell
            label="Depletion"
            value={`${displayDepletionPct.toFixed(displayDepletionPct >= 10 ? 0 : 1)}%`}
            sub={collection === "nfl-all-day" ? "of all minted packs" : tierCountsUpdatedAt ? "live pool" : merged.ev_depletion_pct === null ? undefined : `Pool ${merged.ev_depletion_pct}%`}
          />
        )}
        {!isRewardPack && (
          <KpiCell
            label="Packs remaining"
            value={fmtCount(effectiveUnopened)}
            sub={effectiveTotalMinted !== null ? `of ${fmtCount(effectiveTotalMinted)} minted` : undefined}
          />
        )}
      </section>

      {/* ── AllDay corrected-EV provenance + low-confidence caveat ─────────── */}
      {useCorrectedEv && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.5,
            padding: "10px 12px",
            borderRadius: 8,
            border: `1px solid ${correctedEv!.low_confidence_ev ? "rgba(251,191,36,0.35)" : "rgba(255,255,255,0.12)"}`,
            background: correctedEv!.low_confidence_ev ? "rgba(251,191,36,0.07)" : "rgba(255,255,255,0.03)",
            color: correctedEv!.low_confidence_ev ? "rgb(251,191,36)" : "rgba(255,255,255,0.6)",
          }}
        >
          {correctedEv!.low_confidence_ev && <strong>⚠ Rough estimate. </strong>}
          EV is odds-corrected — tiers valued by median FMV and weighted by{" "}
          {correctedEv!.ev_method === "published_odds" ? "published pack odds" : "circulation share"}
          {" "}(a robust cross-check of the headline supply-weighted EV, resistant to per-edition FMV outliers).
          {correctedEv!.low_confidence_ev && (() => {
            const stale = num(correctedEv!.stale_value_share_pct)
            return stale !== null && stale > 0
              ? ` ~${Math.round(stale)}% of pack value rests on sparse or missing sales data — treat as a rough estimate.`
              : " It rests on thin AllDay FMV — treat as a rough estimate."
          })()}
        </div>
      )}

      {/* ── Packs Content Remaining (Item 1 — TS-style donut + tier bars) ── */}
      {/* F4: null the packs-unopened ring inputs for reward packs — its
          unopened/minted denominator is the dead-by-design counter. The tier
          bars use live pool data (remaining/original by tier) and stay. */}
      <PacksContentRemaining
        unopened={isRewardPack ? null : effectiveUnopened}
        totalMinted={isRewardPack ? null : effectiveTotalMinted}
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

      {/* ── Streamed group (P3): sales history · what's inside · top pulls.
          Off the shell critical path, light skeleton while it resolves. ── */}
      {/* The fallback is BOUNDED (PackContentsFallback): it is only mounted while
          this boundary is unresolved, so if the streamed swap never lands it
          recovers the contents over /api/entity/pack and, failing that, says so
          with a retry — instead of spinning on "Loading pack contents…" forever,
          which is what production did before 2026-07-25. */}
      <Suspense
        fallback={
          <PackContentsFallback
            collection={collection}
            distId={distId}
            pageSize={PACK_CONTENTS_PAGE_SIZE}
          />
        }
      >
        <PackStreamedBottom
          collectionId={coll.id}
          distId={distId}
          collection={collection}
          fmvCoverage={fmvCoverage}
          editionCount={editionCount}
          totalUnopened={totalUnopened}
          slots={merged.slots ?? null}
          snapshottedAt={snapshottedAt}
        />
      </Suspense>
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
                {tsTileImg(collection, e.rep_nft_id, e.thumbnail_url) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={tsTileImg(collection, e.rep_nft_id, e.thumbnail_url) as string}
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

function ShortWallet({ address, name }: { address: string | null; name?: string | null }) {
  if (!address) return <span style={{ color: "rgba(255,255,255,0.4)" }}>—</span>
  const trunc = address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
  return (
    <Link
      href={`/analytics/wallets/${address.toLowerCase()}`}
      title={name ? `${name} · ${address}` : address}
      style={{ color: "#fff", textDecoration: "none", borderBottom: "1px dotted rgba(255,255,255,0.25)" }}
    >
      {name ? `@${name}` : trunc}
    </Link>
  )
}

function PackSalesTable({ title, rows, names }: { title: string; rows: PackSaleRow[]; names: Map<string, string> }) {
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
                <Td><ShortWallet address={s.buyer_address} name={s.buyer_address ? names.get(s.buyer_address.toLowerCase()) ?? null : null} /></Td>
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

function PackSalesHistory({ rows, names }: { rows: PackSaleRow[]; names: Map<string, string> }) {
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
          {top.length > 0 && <PackSalesTable title="Top purchases" rows={top} names={names} />}
          {recent.length > 0 && <PackSalesTable title="Recent purchases" rows={recent} names={names} />}
        </div>
      )}
    </section>
  )
}

// ── P3: streamed section groups ─────────────────────────────────────────────
// Fetched off the shell critical path (the shell renders from get_pack_detail_bundle
// alone). Grouped into two async components — one per DOM position — so the heavy
// queries never block first paint and a slow one degrades to nothing/skeleton
// instead of timing out the whole page under connection-pool pressure.

function PackSectionSkeleton({ label }: { label: string }) {
  return (
    <section style={{ ...CARD_STYLE, color: "rgba(255,255,255,0.35)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
      {label}
    </section>
  )
}

// Top group: observed lifecycle · EV reality check · what drives the remaining EV
// · sealed-pack resale. (All conditional/supplementary — fallback={null}.)
async function PackStreamedTop({
  collection,
  distId,
  authoritativeDepletionPct,
}: {
  collection: string
  distId: string
  authoritativeDepletionPct: number | null
}) {
  const [lifecycle, realizedEv, evContributors, packMarket] = await Promise.all([
    fetchPackLifecycle(collection, distId),
    fetchPackRealizedEv(collection, distId),
    fetchEvContributors(collection, distId),
    fetchPackMarket(collection, distId),
  ])

  // Observed lifecycle
  const lcOpened = num(lifecycle?.packs_opened)
  const lcConfirmed = num(lifecycle?.packs_opened_confirmed)
  const lcInferred = num(lifecycle?.packs_opened_inferred)
  const lcSealed = num(lifecycle?.packs_sealed_observed)
  const lcMoments = num(lifecycle?.moments_pulled)
  const lcRealizedTotal = num(lifecycle?.realized_pull_value_usd)
  const lcAvgPerPack = num(lifecycle?.avg_realized_value_per_pack)
  const lcDepletion = authoritativeDepletionPct ?? num(lifecycle?.observed_depletion_pct)
  const lcDepletionAuthoritative = authoritativeDepletionPct !== null
  const showLifecycle = lcOpened !== null && lcOpened > 0
  const lcInferredOnly = (lcConfirmed ?? 0) === 0 && (lcInferred ?? 0) > 0
  // TS + AllDay pack-open history is reconstructed to genesis via the Dapper
  // searchPackNft registry (complete). Golazos/Pinnacle remain on-chain-window only.
  // AllDay's v_allday_pack_lifecycle count is complete (on-chain open ingest).
  // Top Shot's get_pack_lifecycle_row counts only opens ATTRIBUTED to this dist via
  // the pack_rips bridge (partial: ~20% and growing) — NOT the complete open history,
  // which lives in the supply counters shown in the KPI row above (total_opened /
  // Depletion). Label the TS number as the sample it is so it never contradicts them.
  const lcSince = collection === "nfl-all-day" ? "complete open history" : "attributed rips · sample"

  // Modeled-vs-realized reality check
  const reModeled = num(realizedEv?.modeled_gross_ev)
  const reOpens = num(realizedEv?.n_opens)
  const reMean = num(realizedEv?.realized_mean)
  const reMedian = num(realizedEv?.realized_median)
  const reP90 = num(realizedEv?.realized_p90)
  const reRatio = num(realizedEv?.realized_to_modeled_ratio)
  const reCalibrated = num(realizedEv?.calibrated_ev)
  // Modeled gross EV is NULL when the pool can't be honestly priced (sentinel row) —
  // still show the panel on the realized pull distribution alone (it's the more
  // trustworthy number anyway), just without the modeled-vs-actual comparison.
  const hasModeled = reModeled !== null && reModeled > 0
  const showRealizedEv =
    reMean !== null && reOpens !== null && reOpens >= 10
  const showCalibrated =
    hasModeled && reCalibrated !== null &&
    Math.abs(reCalibrated - reModeled!) / reModeled! >= 0.1
  const reVerdict =
    reRatio === null ? null
    : reRatio < 0.6 ? { label: "Model over-values vs actual pulls", accent: "rgb(248,113,113)" }
    : reRatio > 1.4 ? { label: "Model under-values vs actual pulls", accent: "rgb(110,231,183)" }
    : { label: "Model tracks actual pulls", accent: "rgba(255,255,255,0.85)" }

  // EV contributors (Top Shot)
  const showEvContributors = collection === "nba-top-shot" && evContributors.length > 0
  const evContributorsLowConfShare = evContributors
    .filter((c) => ["LOW", "ASK_ONLY", "STALE", "NO_DATA"].includes(String(c.confidence)))
    .reduce((s, c) => s + (num(c.pct_of_ev) ?? 0), 0)

  // Sealed-pack resale market
  const pmSales = num(packMarket?.n_sales)
  const pmSales90 = num(packMarket?.n_sales_90d)
  const pmMedian90 = num(packMarket?.median_price_90d)
  const pmLast = num(packMarket?.last_sale_price)
  const pmLastAt = packMarket?.last_sale_at ?? null
  const pmRetail = num(packMarket?.retail_price)
  const pmRatio = num(packMarket?.secondary_vs_retail_ratio)
  const showPackMarket = pmSales !== null && pmSales > 0 && (pmMedian90 !== null || pmLast !== null)
  const pmVerdict =
    pmRatio === null ? null
    : pmRatio >= 1.15 ? { label: `trades ${pmRatio.toFixed(2)}× retail — secondary premium`, accent: "rgb(110,231,183)" }
    : pmRatio <= 0.85 ? { label: `trades ${pmRatio.toFixed(2)}× retail — secondary discount`, accent: "rgb(252,211,77)" }
    : { label: `trades ~${pmRatio.toFixed(2)}× retail`, accent: "rgba(255,255,255,0.85)" }

  return (
    <>
      {showLifecycle && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
            Observed pack lifecycle
          </span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <KpiCell
              label="Packs opened"
              value={fmtCount(lcOpened)}
              sub={
                lcInferredOnly
                  ? `${lcSince} · inferred`
                  : lcInferred != null && lcInferred > 0 && lcConfirmed != null
                    ? `${lcSince} · ${fmtCount(lcConfirmed)} confirmed`
                    : lcSince
              }
            />
            <KpiCell label="Moments pulled" value={fmtCount(lcMoments)} sub="from opened packs" />
            <KpiCell label="Realized pull value" value={fmtUsd(lcRealizedTotal)} sub="total, observed pulls" />
            <KpiCell label="Avg / pack" value={fmtUsd(lcAvgPerPack)} sub="realized pull value" />
            {lcSealed != null && lcSealed > 0 && (
              <KpiCell label="Sealed (observed)" value={fmtCount(lcSealed)} sub="still unopened" />
            )}
            {lcDepletion != null && lcDepletionAuthoritative && (
              <KpiCell
                label="Opened share"
                value={`${lcDepletion.toFixed(lcDepletion >= 10 ? 0 : 1)}%`}
                sub="of all minted packs"
              />
            )}
          </div>
        </section>
      )}

      {showRealizedEv && (
        <section style={{ background: "rgba(13,13,13,0.92)", border: "1px solid rgba(255,255,255,0.06)", borderLeft: `3px solid ${reVerdict?.accent ?? "rgba(255,255,255,0.2)"}`, borderRadius: 6, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
            {hasModeled ? "EV reality check" : "Realized pull value"}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px" }}>
            {hasModeled && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
                Modeled <strong style={{ color: "rgba(255,255,255,0.9)" }}>{fmtUsd(reModeled)}</strong>/pack
              </span>
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: reVerdict?.accent ?? "rgba(255,255,255,0.85)" }}>
              {hasModeled ? "vs realized " : "Realized "}<strong>{fmtUsd(reMean)}</strong> avg
              {reMedian != null ? ` · ${fmtUsd(reMedian)} median` : ""}
              {reP90 != null ? ` · ${fmtUsd(reP90)} p90` : ""}
            </span>
            {reRatio != null && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: reVerdict?.accent ?? "rgba(255,255,255,0.85)" }}>
                ({reRatio.toFixed(2)}×)
              </span>
            )}
          </div>
          {showCalibrated && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.9)" }}>
                Calibrated estimate <strong style={{ color: "rgb(250,204,21)" }}>{fmtUsd(reCalibrated)}</strong>/pack
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
                model blended toward observed pulls
              </span>
            </div>
          )}
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            {reVerdict?.label ?? "Realized pull value"} · {fmtCount(reOpens)} attributed opens
          </span>
        </section>
      )}

      {showEvContributors && (
        <section style={CARD_STYLE}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase" }}>
              What drives the remaining EV
            </h2>
          </div>
          <p style={{ margin: "0 0 10px", color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.5 }}>
            Each row is an edition still in the pool. EV share = pull odds × FMV as a fraction of the pack per-slot
            expected value — what the remaining contents are actually worth.
          </p>
          {evContributorsLowConfShare >= 25 && (
            <p style={{ margin: "0 0 10px", color: "rgb(252,211,77)", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.5 }}>
              ⚠ {Math.round(evContributorsLowConfShare)}% of the remaining EV leans on thinly-traded chase prices — treat it as soft.
            </p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <Th>Edition</Th>
                  <Th>Tier</Th>
                  <Th align="right">Pull %</Th>
                  <Th align="right">FMV</Th>
                  <Th align="right">EV share</Th>
                </tr>
              </thead>
              <tbody>
                {evContributors.map((c) => {
                  const pull = num(c.pull_prob)
                  const evShare = num(c.pct_of_ev)
                  return (
                    <tr key={c.edition_id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                      <Td>
                        {c.external_id ? (
                          <Link href={`/${collection}/edition/${encodeURIComponent(c.external_id)}`} style={{ color: "#fff", textDecoration: "none" }}>
                            {c.player_name || "—"}
                          </Link>
                        ) : (
                          <span style={{ color: "#fff" }}>{c.player_name || "—"}</span>
                        )}
                        <span style={{ color: "rgba(255,255,255,0.4)" }}> · {c.set_name || "—"}</span>
                      </Td>
                      <Td color={c.tier ? tierChip(String(c.tier)).color : undefined}>
                        {c.tier ? String(c.tier).charAt(0).toUpperCase() + String(c.tier).slice(1) : "—"}
                      </Td>
                      <Td align="right">{pull === null ? "—" : `${(pull * 100).toFixed(2)}%`}</Td>
                      <Td align="right">{fmtUsd(num(c.fmv_usd))}</Td>
                      <Td align="right">{evShare === null ? "—" : `${evShare.toFixed(1)}%`}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.35)" }}>
            EV share = pull odds × FMV ÷ per-slot EV, over the editions remaining in the pool.
          </div>
        </section>
      )}

      {showPackMarket && (
        <section style={{ background: "rgba(13,13,13,0.92)", border: "1px solid rgba(255,255,255,0.06)", borderLeft: `3px solid ${pmVerdict?.accent ?? "rgba(255,255,255,0.2)"}`, borderRadius: 6, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)" }}>
            Sealed pack resale
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 14px" }}>
            {pmMedian90 !== null && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
                Median <strong style={{ color: "rgba(255,255,255,0.9)" }}>{fmtUsd(pmMedian90)}</strong>
                <span style={{ color: "rgba(255,255,255,0.4)" }}> (90d)</span>
              </span>
            )}
            {pmLast !== null && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.7)" }}>
                Last <strong style={{ color: "rgba(255,255,255,0.9)" }}>{fmtUsd(pmLast)}</strong>
                {fmtAgo(pmLastAt) ? <span style={{ color: "rgba(255,255,255,0.4)" }}> · {fmtAgo(pmLastAt)}</span> : null}
              </span>
            )}
            {pmRetail !== null && pmRetail > 0 && (
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
                Retail {fmtUsd(pmRetail)}
              </span>
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
              {fmtCount(pmSales)} sale{pmSales === 1 ? "" : "s"}
              {pmSales90 !== null && pmSales90 > 0 ? ` · ${fmtCount(pmSales90)} in 90d` : ""}
            </span>
          </div>
          {pmVerdict && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: pmVerdict.accent }}>
              {pmVerdict.label}
            </span>
          )}
        </section>
      )}
    </>
  )
}

// Bottom group: sales history · what's inside grid · top pulls by EV.
async function PackStreamedBottom({
  collectionId,
  distId,
  collection,
  fmvCoverage,
  editionCount,
  totalUnopened,
  slots,
  snapshottedAt,
}: {
  collectionId: string
  distId: string
  collection: string
  fmvCoverage: number | null
  editionCount: number | null
  totalUnopened: number | null
  slots: number | null
  snapshottedAt: string | null
}) {
  const [salesHistory, packContents, exhaustedCount, topPulls] = await Promise.all([
    fetchPackSalesHistory(collectionId, distId, 10),
    fetchPackContents(collectionId, distId, PACK_CONTENTS_PAGE_SIZE, 0),
    fetchExhaustedCount(collectionId, distId),
    fetchTopPulls(collectionId, distId, totalUnopened, slots),
  ])

  const packSaleNames = await resolveUsernames(
    salesHistory.flatMap((s) => [s.buyer_address, s.seller_address]).filter((a): a is string => !!a),
  )

  return (
    <>
      <PackSalesHistory rows={salesHistory} names={packSaleNames} />

      {packContents === null && (
        <section style={{ ...CARD_STYLE, fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.55)" }}>
          Couldn&apos;t load this pack&apos;s contents. The rest of the page is accurate — only this
          panel is missing. Reload to try again.
        </section>
      )}

      {packContents !== null && packContents.length > 0 && (
        <section style={CARD_STYLE}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase" }}>
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

      <section style={CARD_STYLE}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "0.06em", color: "#fff", textTransform: "uppercase" }}>
            Top pulls by EV
          </h2>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            {topPulls.length === 0 ? "computing pack contents…" : `top ${topPulls.length} of ${editionCount ?? "?"}`}
          </span>
        </div>
        {topPulls.length === 0 ? (
          <div style={{ padding: "12px 14px", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 6, color: "rgba(255,255,255,0.4)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            Drop-pool contents aren&apos;t indexed for this distribution yet. Older/depleted packs are re-pooled from Dapper Atlas remaining-count data as that harvest runs.
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
                      {fmtUsdEv(p.editionEv)}
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
    </>
  )
}
