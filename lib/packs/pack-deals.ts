// lib/packs/pack-deals.ts
//
// PACK SNIPER deal feed — the shared server-side logic that joins LIVE sealed-pack
// secondary asks (Dapper Studio, via lib/packs/live-pack-listings.ts) to the
// pack EV view (pack_table_rows) and applies honesty gates, then orders the deal
// set by RECENCY (ask changed-at) with value as the tie-break.
//
// Consumed by:
//   - app/api/public/insights/pack-sniper/route.ts  (public board data source)
//   - app/insights/pack-sniper/page.tsx             (server-rendered default view)
//   - app/(collections)/[collection]/pack-sniper/page.tsx
//
// RECENCY OVERLAY (2026-06-21). The Dapper Studio aggregation has no per-listing
// timestamp, so /api/cron/snapshot-pack-asks diffs the live book over time into
// public.pack_ask_state. This module LEFT-JOINs that state (is_listed=true) to
// flag NEW / price-dropped packs and to order the board "as they get listed".
// The join is non-fatal: before the snapshot cron runs (or if it errors) the
// recency fields are null and the board degrades to value order. This module
// only READS pack_table_rows + pack_ask_state; it changes no EV/FMV/pricing.
//
// RANK, DON'T PRICE (2026-05-29 research thread). gross_ev is a drop-weighted
// EXPECTATION, not a typical outcome. For chance-hit / single-chase packs the
// distribution is wildly skewed, so we:
//   1. NEVER score against the cached/stale view ask — always the live ask.
//   2. Flag high-variance packs (gross_ev > 3 × ask, depletion >= 60,
//      coverage < 80, single-slot chase). The board hides these by default.
//   3. Surface the FMV-coverage chip + a simulator link on every row.

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
  grossEV: number
  /** gross_ev / live lowest ask. > 1 means EV exceeds the live ask. */
  liveValueRatio: number
  /** 1 - (ask / gross_ev), clamped to [0,1). */
  discountPct: number
  fmvCoveragePct: number
  evSnapshottedAt: string | null
  editionCount: number | null
  depletionPct: number | null
  highVariance: boolean
  highVarianceReasons: string[]
  buyUrl: string
  dapperUrl: string
  detailHref: string
  simulatorHref: string
  // ── Recency overlay (from pack_ask_state; null until the snapshot cron runs) ──
  /** When this dist's lowest ask last changed (new listing or price move). Drives "Recently Listed". */
  askChangedAt: string | null
  /** When this dist's current listed run began (reset when it re-lists after going unlisted). */
  askFirstSeenAt: string | null
  /** The lowest ask immediately before the most recent change (enables the ▼ badge). */
  prevAsk: number | null
  /** Listed (or re-listed) within RECENCY_WINDOW. */
  isNew: boolean
  /** Lowest ask dropped vs prevAsk within RECENCY_WINDOW (and not brand-new). */
  isPriceDrop: boolean
  /** 1 - (ask / prevAsk) when isPriceDrop, else null. */
  askDropPct: number | null
}

export type PackDealsResult = {
  collection: PackCollectionSlug
  deals: PackDeal[]
  stats: {
    liveListings: number
    gatedEvRows: number
    matched: number
    positiveEv: number
    highVariance: number
    returned: number
  }
}

const MIN_FMV_COVERAGE = 80
const EV_FRESH_HOURS = 72
const MAX_DEPLETION_PCT = 90

const HIGH_VARIANCE_RATIO = 3
const HIGH_VARIANCE_DEPLETION = 60

// How long a freshly-listed / price-dropped pack wears its NEW / ▼ badge. The
// snapshot cron resolves changes at its cadence (~5m); this is the display
// window, not the detection resolution.
const RECENCY_WINDOW_MS = 120 * 60 * 1000

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

type AskStateRow = {
  dist_id: string
  lowest_ask: number | null
  prev_ask: number | null
  ask_first_seen_at: string | null
  ask_changed_at: string | null
}

function leagueFor(collection: PackCollectionSlug): "nba" | "nfl" {
  return collection === "nfl-all-day" ? "nfl" : "nba"
}

function buyUrlFor(
  collection: PackCollectionSlug,
  distId: string,
  packListingId: string,
): string {
  if (collection === "nfl-all-day") {
    return dapperMarketPackUrl({ league: "nfl", distId })
  }
  const uuid = packListingId && packListingId !== distId ? packListingId : null
  return topshotPackUrl({ distId, packListingUuid: uuid })
}

/**
 * Build the recency-ordered Pack Sniper deal feed for a collection.
 *
 * @param collection  "nba-top-shot" | "nfl-all-day"
 * @param opts.limit  max deals to return (default 50, capped 200)
 * @param opts.includeHighVariance  when false, high-variance packs are dropped.
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

  // Pull live listings + gated EV rows + recency state in parallel.
  const [{ listings }, evRes, askRes] = await Promise.all([
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
    // Recency state via the one-row jsonb RPC (get_pack_ask_state_map) instead of
    // a table read — PostgREST clamps any select to 1000 rows and TS has ~1,900
    // listed dists, so a .from().limit() silently dropped ~half the recency map.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any).rpc("get_pack_ask_state_map", { p_collection_slug: collection }),
  ])

  if (evRes.error) {
    throw new Error(`pack_table_rows read failed: ${evRes.error.message}`)
  }

  const evByDist = new Map<string, EvRow>()
  for (const row of (evRes.data ?? []) as EvRow[]) {
    if (row.dist_id) evByDist.set(String(row.dist_id), row)
  }

  // Recency overlay is non-fatal — a read error just means no NEW/▼ flags today.
  // askRes.data is a clamp-proof jsonb object keyed by dist_id (one row, from
  // get_pack_ask_state_map) → build the map from its entries.
  const askByDist = new Map<string, AskStateRow>()
  if (!askRes?.error && askRes?.data && typeof askRes.data === "object") {
    for (const [distId, v] of Object.entries(
      askRes.data as Record<string, Omit<AskStateRow, "dist_id">>,
    )) {
      askByDist.set(String(distId), { dist_id: String(distId), ...v })
    }
  }

  let matched = 0
  let positiveEv = 0
  let highVarianceCount = 0
  const deals: PackDeal[] = []
  const nowMs = Date.now()

  for (const lst of listings) {
    if (lst.lowestAsk <= 0) continue
    const ev = evByDist.get(String(lst.distId))
    if (!ev || ev.gross_ev == null) continue
    matched += 1

    const grossEV = Number(ev.gross_ev)
    const liveValueRatio = grossEV / lst.lowestAsk
    if (!(liveValueRatio > 1)) continue
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

    // ── Recency overlay ──
    const askState = askByDist.get(String(lst.distId))
    const askChangedAt = askState?.ask_changed_at ?? null
    const askFirstSeenAt = askState?.ask_first_seen_at ?? null
    const prevAsk = askState?.prev_ask != null ? Number(askState.prev_ask) : null
    const firstSeenMs = askFirstSeenAt ? Date.parse(askFirstSeenAt) : NaN
    const changedMs = askChangedAt ? Date.parse(askChangedAt) : NaN
    const isNew = Number.isFinite(firstSeenMs) && nowMs - firstSeenMs <= RECENCY_WINDOW_MS
    const isPriceDrop =
      !isNew &&
      prevAsk != null &&
      lst.lowestAsk < prevAsk &&
      Number.isFinite(changedMs) &&
      nowMs - changedMs <= RECENCY_WINDOW_MS
    const askDropPct =
      isPriceDrop && prevAsk ? Math.max(0, Math.min(0.9999, 1 - lst.lowestAsk / prevAsk)) : null

    deals.push({
      distId: lst.distId,
      title: lst.title,
      tier: lst.tier,
      imageUrl: lst.imageUrl,
      slots,
      lowestAsk: lst.lowestAsk,
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
      askChangedAt,
      askFirstSeenAt,
      prevAsk,
      isNew,
      isPriceDrop,
      askDropPct,
    })
  }

  // Default order = recency ("as they get listed"): most-recently-changed ask
  // first, value as the tie-break. Before the snapshot cron populates
  // pack_ask_state every ask_changed_at is null -> this degrades to value order.
  // The client re-sorts the returned set for the other sort options, so as long
  // as `limit` (>= 200 from the callers) exceeds the deal count it has the full
  // set to sort. If the deal count ever exceeds the limit, the LEAST-recent
  // deals are dropped — raise the caller limit if that ever bites.
  deals.sort((a, b) => {
    const at = a.askChangedAt ? Date.parse(a.askChangedAt) : 0
    const bt = b.askChangedAt ? Date.parse(b.askChangedAt) : 0
    if (bt !== at) return bt - at
    return b.liveValueRatio - a.liveValueRatio
  })
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
