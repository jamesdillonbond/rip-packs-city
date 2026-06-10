// lib/packs/pack-deals.ts
//
// PACK SNIPER deal feed — the shared server-side logic that joins LIVE sealed-pack
// secondary asks (Dapper Studio, via lib/packs/live-pack-listings.ts) to the
// pack EV view (pack_table_rows) and applies honesty gates, then ranks by
// live-ask-vs-EV value ratio.
//
// Consumed by:
//   - app/api/public/insights/pack-sniper/route.ts  (public board data source)
//   - app/insights/pack-sniper/page.tsx             (server-rendered default view)
//
// RANK, DON'T PRICE (2026-05-29 research thread). gross_ev is a drop-weighted
// EXPECTATION, not a typical outcome. For chance-hit / single-chase packs the
// distribution is wildly skewed — a $10 pack with a 0.5% shot at a $2,000 moment
// has gross_ev ~$900 but the modal outcome is $0. So we:
//   1. NEVER score against the cached/stale view ask — always the live ask.
//   2. Flag high-variance packs with the SAME rule the pack-reality board uses
//      (gross_ev > 3 × ask, depletion >= 60, coverage < 80) PLUS single-slot
//      chase packs. The board hides these by default and reveals them flagged.
//   3. Surface the FMV-coverage chip + a simulator link on every row as the
//      honesty valves — the simulator shows the real outcome distribution.
//
// This module only READS pack_table_rows. It changes no EV/FMV/pricing logic.

import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchLivePackListings,
  isSupportedPackCollection,
  type PackCollectionSlug,
} from "@/lib/packs/live-pack-listings"
import { topshotPackUrl, dapperMarketPackUrl } from "@/lib/pack-urls"

export type PackDeal = {
  distId: string
  title: string
  tier: string
  imageUrl: string
  slots: number
  lowestAsk: number
  listingCount: number
  grossEV: number
  /** gross_ev / live lowest ask. > 1 means EV exceeds the live ask. */
  liveValueRatio: number
  /** 1 - (ask / gross_ev), clamped to [0,1). */
  discountPct: number
  fmvCoveragePct: number
  evSnapshottedAt: string | null
  editionCount: number | null
  depletionPct: number | null
  /**
   * True when the EV is dominated by a rare tail (lottery structure) — the
   * modal outcome is far below gross_ev. Reuses the pack-reality board rule.
   * Reasons are surfaced so the UI can explain the flag honestly.
   */
  highVariance: boolean
  highVarianceReasons: string[]
  /**
   * Primary outbound listing link. TS → nbatopshot.com/drop/<distId> (native
   * P2P, best book). AllDay → dapper.market (browser-verified buyable; the
   * nflallday.com/pack shape is still unverified).
   */
  buyUrl: string
  /**
   * Secondary outbound link to the dapper.market pack modal — verified buyable
   * but shows a subset of the listing book (see dapperMarketPackUrl caveat).
   * Rendered as a small secondary link beside the primary on every board row.
   */
  dapperUrl: string
  detailHref: string
  simulatorHref: string
}

export type PackDealsResult = {
  collection: PackCollectionSlug
  deals: PackDeal[]
  /** Counts for honest "what was dropped" reporting (no silent caps). */
  stats: {
    liveListings: number
    gatedEvRows: number
    matched: number
    positiveEv: number
    highVariance: number
    returned: number
  }
}

// Honesty gate constants. Coverage floor matches the handoff (stricter than the
// pack-reality board's 40 — a public deal board should not promote an EV built
// on <80% priced editions). Freshness 72h; depletion < 90 drops near-dead packs.
const MIN_FMV_COVERAGE = 80
const EV_FRESH_HOURS = 72
const MAX_DEPLETION_PCT = 90

// High-variance rule (mirrors topshot_pack_reality_top_ev.high_variance):
//   gross_ev > 3 × ask  OR  depletion >= 60  OR  coverage < 80
const HIGH_VARIANCE_RATIO = 3
const HIGH_VARIANCE_DEPLETION = 60

type EvRow = {
  dist_id: string
  gross_ev: number | null
  fmv_coverage_pct: number | null
  ev_snapshotted_at: string | null
  is_rare_single_pack: boolean | null
  depletion_pct: number | null
  edition_count: number | null
  slots: number | null
}

function leagueFor(collection: PackCollectionSlug): "nba" | "nfl" {
  return collection === "nfl-all-day" ? "nfl" : "nba"
}

function buyUrlFor(
  collection: PackCollectionSlug,
  distId: string,
  packListingId: string,
): string {
  // AllDay: the nflallday.com/pack shape is still unverified, so use the
  // browser-verified dapper.market deep link as the primary buy surface.
  if (collection === "nfl-all-day") {
    return dapperMarketPackUrl({ league: "nfl", distId })
  }
  // TS: native /drop/<distId> (best book) stays primary.
  return topshotPackUrl({ distId, packListingUuid: packListingId })
}

/**
 * Build the ranked Pack Sniper deal feed for a collection.
 *
 * @param collection  "nba-top-shot" | "nfl-all-day"
 * @param opts.limit  max deals to return (default 50, capped 200)
 * @param opts.includeHighVariance  when false (default true here — the API
 *        returns everything and the UI decides), high-variance packs are dropped
 *        from the returned list. The board itself defaults to hiding them.
 */
export async function getPackDeals(
  collection: string,
  opts: { limit?: number; includeHighVariance?: boolean } = {},
): Promise<PackDealsResult> {
  if (!isSupportedPackCollection(collection)) {
    throw new Error(`Unsupported collection '${collection}'`)
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const includeHighVariance = opts.includeHighVariance ?? true

  const evCutoff = new Date(Date.now() - EV_FRESH_HOURS * 3600 * 1000).toISOString()

  // Pull live listings + gated EV rows in parallel.
  const [{ listings }, evRes] = await Promise.all([
    fetchLivePackListings(collection),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("pack_table_rows")
      .select(
        "dist_id, gross_ev, fmv_coverage_pct, ev_snapshotted_at, is_rare_single_pack, depletion_pct, edition_count, slots",
      )
      .eq("collection_slug", collection)
      .not("gross_ev", "is", null)
      .gte("fmv_coverage_pct", MIN_FMV_COVERAGE)
      .eq("is_rare_single_pack", false)
      .gte("ev_snapshotted_at", evCutoff)
      .lt("depletion_pct", MAX_DEPLETION_PCT)
      .limit(2000),
  ])

  if (evRes.error) {
    throw new Error(`pack_table_rows read failed: ${evRes.error.message}`)
  }

  const evByDist = new Map<string, EvRow>()
  for (const row of (evRes.data ?? []) as EvRow[]) {
    if (row.dist_id) evByDist.set(String(row.dist_id), row)
  }

  let matched = 0
  let positiveEv = 0
  let highVarianceCount = 0
  const deals: PackDeal[] = []

  for (const lst of listings) {
    if (lst.lowestAsk <= 0) continue
    const ev = evByDist.get(String(lst.distId))
    if (!ev || ev.gross_ev == null) continue
    matched += 1

    const grossEV = Number(ev.gross_ev)
    const liveValueRatio = grossEV / lst.lowestAsk
    if (!(liveValueRatio > 1)) continue // a "deal" requires EV above the live ask
    positiveEv += 1

    const coverage = ev.fmv_coverage_pct ?? 0
    const depletion = ev.depletion_pct ?? 0
    const slots = lst.momentsPerPack ?? ev.slots ?? 1

    const reasons: string[] = []
    if (liveValueRatio > HIGH_VARIANCE_RATIO) reasons.push("ev_gt_3x_ask")
    if (depletion >= HIGH_VARIANCE_DEPLETION) reasons.push("depleted_60pct")
    if (coverage < 80) reasons.push("thin_fmv_coverage")
    if (slots <= 1) reasons.push("single_slot_chase")
    const highVariance = reasons.length > 0
    if (highVariance) highVarianceCount += 1

    if (!includeHighVariance && highVariance) continue

    deals.push({
      distId: lst.distId,
      title: lst.title,
      tier: lst.tier,
      imageUrl: lst.imageUrl,
      slots,
      lowestAsk: lst.lowestAsk,
      listingCount: lst.listingCount,
      grossEV,
      liveValueRatio,
      discountPct: Math.max(0, Math.min(0.9999, 1 - lst.lowestAsk / grossEV)),
      fmvCoveragePct: coverage,
      evSnapshottedAt: ev.ev_snapshotted_at,
      editionCount: ev.edition_count,
      depletionPct: ev.depletion_pct,
      highVariance,
      highVarianceReasons: reasons,
      buyUrl: buyUrlFor(collection, lst.distId, lst.packListingId),
      dapperUrl: dapperMarketPackUrl({ league: leagueFor(collection), distId: lst.distId }),
      detailHref: `/${collection}/pack/dist/${lst.distId}`,
      simulatorHref: `/${collection}/packs/simulator/${lst.distId}`,
    })
  }

  // Rank by live value ratio desc — the ordering IS the product (rank, don't price).
  deals.sort((a, b) => b.liveValueRatio - a.liveValueRatio)
  const returned = deals.slice(0, limit)

  return {
    collection,
    deals: returned,
    stats: {
      liveListings: listings.length,
      gatedEvRows: evByDist.size,
      matched,
      positiveEv,
      highVariance: highVarianceCount,
      returned: returned.length,
    },
  }
}
