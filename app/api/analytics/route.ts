import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { bucketAcquisitionCounts } from "@/lib/analytics/shape"
import { apiErrorResponse } from "@/lib/api-error"
import { isCadenceAddress, isSolanaAddress, normalizeAddress } from "@/lib/address"
import { boundedRead } from "@/lib/api/bounded-read"
import { resolveToFlowAddress, UsernameLookupUnavailableError, usernameLookupUnavailableResponse } from "@/lib/chains/flow/flow-resolve"
import { ownLookup } from "@/lib/safe-lookup"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
// Pages of get_wallet_moments_with_fmv read per request (1,000 each, FMV-desc).
const MAX_PAGES = 10
const VALID_UUIDS = new Set(Object.values(COLLECTION_UUID_BY_SLUG))

const SERIES_MAP: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

async function resolveWallet(input: string): Promise<string> {
  const t = input.trim()
  // An on-chain address passes through, normalised per chain: Flow hex folds,
  // a Candy (Solana) base58 key stays verbatim. Before 2026-10-09 only a 0x/18
  // shape passed, so a Candy wallet on the analytics Portfolio tab went to the
  // Top Shot username lookup and failed ("Could not resolve username").
  if (isCadenceAddress(t) || isSolanaAddress(t)) return normalizeAddress(t)
  // 2026-09-29: the shared ladder (cache → live Atlas → Top Shot GQL). The local
  // copy went cache → the dead Top Shot host only, so a username not already
  // cached could never resolve here. A miss throws "Could not resolve …"; a
  // failure to look throws UsernameLookupUnavailableError (answered 503).
  try {
    return await resolveToFlowAddress(t)
  } catch (err) {
    if (err instanceof UsernameLookupUnavailableError) throw err
    // A confirmed miss is about the caller's own input: publishable.
    throw new PublicApiError("Could not resolve username to wallet address.")
  }
}

/**
 * An error WE authored, whose message explains the CALLER's own input and is
 * therefore safe — and useful — to publish.
 *
 * ⚠ The generic catch at the bottom of this route classifies everything through
 * apiErrorResponse, which is right for a Supabase/driver error and wrong for
 * this one: a visitor who typed a username we cannot resolve needs to be told
 * that, not "Analytics aren't available right now." Marking ours keeps the
 * driver-message guard satisfied without flattening a domain error into an
 * outage message.
 */
class PublicApiError extends Error {
  /**
   * The publishable text, held in its OWN field rather than reused from
   * `.message`.
   *
   * ⚠ This is not a workaround for the leak guard — it is why the guard can
   * stay strict. Driver errors and ours both populate `.message`, so any rule
   * phrased over `.message` must either flag both or neither. Making
   * publishability an explicit property means the guard can keep rejecting
   * every `error: <x>.message` on sight, and this route still says something
   * useful.
   */
  readonly publicMessage: string
  constructor(publicMessage: string) {
    super(publicMessage)
    this.publicMessage = publicMessage
  }
}

/**
 * render_id → series year for every Pinnacle pin (~2.8k catalog rows, read in
 * 1,000-row pages on a unique key). Throws on a failed page: a partial map
 * would label pins "Unknown" that have a series.
 */
async function readPinnacleSeriesByRender(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await boundedRead(
      (supabaseAdmin as any)
        .from("pinnacle_catalog")
        .select("render_id, series_name")
        .order("render_id", { ascending: true })
        .range(from, from + 999),
      "api/analytics/pinnacle_catalog_series",
    )
    if (error) throw error
    const page = (data ?? []) as Array<{ render_id: string; series_name: string | null }>
    for (const r of page) if (r.series_name) out.set(String(r.render_id), String(r.series_name))
    if (page.length < 1000) break
  }
  return out
}

function resolveCollectionId(raw: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // UUID passed directly — accept if it's one of ours.
  if (VALID_UUIDS.has(trimmed)) return trimmed
  // Slug (hyphen-style: nba-top-shot, nfl-all-day, etc).
  const uuid = ownLookup(COLLECTION_UUID_BY_SLUG, trimmed)
  return uuid ?? null
}

export async function GET(req: NextRequest) {
  try {
    const walletInput = req.nextUrl.searchParams.get("wallet")
    if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const collectionParam = req.nextUrl.searchParams.get("collection_id")
    const collectionId = resolveCollectionId(collectionParam)
    if (!collectionId) {
      return NextResponse.json(
        { error: "collection_id required (slug like nba-top-shot or canonical UUID)" },
        { status: 400 }
      )
    }

    const wallet = await resolveWallet(walletInput)

    // Acquisition stats via RPC.
    // ⚠ 2026-09-28: the error was discarded, so a timeout here rendered as
    // "Acquisition history not yet indexed" (or a zero breakdown). It now
    // fails only THIS panel, reported as `acquisition_failed`.
    const { data: acqRaw, error: acqError } = await boundedRead((supabaseAdmin as any).rpc("get_acquisition_stats", {
      p_wallet: wallet,
      p_collection_id: collectionId,
    }), "api/analytics/get_acquisition_stats")
    const acquisitionFailed = acqError != null
    if (acquisitionFailed) console.log("[analytics] get_acquisition_stats failed:", acqError?.code ?? "timeout")
    const acqResult = (Array.isArray(acqRaw) ? acqRaw[0] : acqRaw) ?? {}
    const acqCounts = bucketAcquisitionCounts(
      acqResult.breakdown as Array<{ method?: string | null; count?: number | null }> | undefined
    )

    // Wallet moments (page 1, large limit) via get_wallet_moments_with_fmv — returns tier/series/is_locked/fmv/confidence
    const PAGE_SIZE = 1000
    const rows: any[] = []
    // ⚠ 2026-09-28: a failed or timed-out page used to read as an EMPTY page —
    // the loop broke and the route published a partial (or $0) wallet as the
    // whole one. A failed page now fails the request (apiErrorResponse below).
    let reportedTotal: number | null = null
    let lastPageFull = false
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await boundedRead((supabaseAdmin as any).rpc("get_wallet_moments_with_fmv", {
        p_wallet: wallet,
        p_sort_by: "fmv_desc",
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
        p_player: null,
        p_series: null,
        p_tier: null,
        p_collection_id: collectionId,
      }), "api/analytics/get_wallet_moments_with_fmv")
      if (error) throw error
      const result = (Array.isArray(data) ? data[0] : data) as { moments?: any[]; total_count?: number } | null
      const batch = result?.moments ?? []
      if (result?.total_count != null) reportedTotal = Number(result.total_count)
      rows.push(...batch)
      lastPageFull = batch.length === PAGE_SIZE
      if (!lastPageFull) break
    }
    // The page cap leaves the lowest-FMV tail unread on the largest wallets.
    // Disclosed, never presented as the whole wallet.
    const truncated =
      (reportedTotal != null && reportedTotal > rows.length) ||
      (lastPageFull && rows.length >= PAGE_SIZE * MAX_PAGES)

    // Pinnacle pins carry no series NUMBER (that map is Top Shot's); their
    // series is the catalog's year (2023–2026). Without this every pin landed
    // in one "Unknown" row.
    const pinnacleSeries = collectionId === PINNACLE_COLLECTION_ID ? await readPinnacleSeriesByRender() : null

    // Tier breakdown
    const tierBreakdown: Record<string, { count: number; fmv: number }> = {}
    const seriesBreakdown: Record<string, { count: number; fmv: number; seriesNumber: number }> = {}
    // Seed every fmv_confidence enum value. SALES_ONLY was previously omitted, so
    // those moments folded into NO_DATA (line below), mis-reporting a real
    // sales-based signal as "no data" in the confidence breakdown.
    const confidenceDist: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, NO_DATA: 0, ASK_ONLY: 0, SALES_ONLY: 0, STALE: 0 }
    let lockedCount = 0
    let unlockedCount = 0
    let lockedFmv = 0
    let unlockedFmv = 0
    // ⛔ THE THIRD STATE. This tally used to be `if (locked) … else …` — a
    // binary else, so a moment whose lock was NEVER CHECKED was counted as
    // UNLOCKED and its FMV added to the figure the UI captions "Locked
    // moments cannot be listed or traded". That is a LIQUIDITY claim about
    // the user's own portfolio, and `wallet_moments_cache.is_locked` defaults
    // to false on 1,160,468 of 1,767,936 Top Shot rows (register #112) — so
    // for most wallets the headline overstated what they can actually sell.
    let lockUnknownCount = 0
    let lockUnknownFmv = 0
    let totalFmv = 0

    for (const r of rows) {
      const tier = (r.tier ? String(r.tier).replace(/^MOMENT_TIER_/i, "").toUpperCase() : "UNKNOWN")
      const fmv = r.fmv_usd != null ? Number(r.fmv_usd) : 0
      const locked = r.is_locked === true
      // `lock_known` is supplied by get_wallet_moments_with_fmv and is true
      // only where the source RECORDS having checked (its `lock_checked_at`).
      // ⚠ Absent key ⇒ false ⇒ unknown, which is the safe direction: an older
      // deployment of the function simply reports everything unverified
      // rather than silently resuming the old overstatement.
      const lockKnown = r.lock_known === true
      const conf = (r.confidence ? String(r.confidence).toUpperCase() : "NO_DATA")
      const pinSeries = pinnacleSeries && r.render_id ? pinnacleSeries.get(String(r.render_id)) ?? null : null
      const seriesNum = pinnacleSeries
        ? (pinSeries != null && Number.isFinite(Number(pinSeries)) ? Number(pinSeries) : -1)
        : r.series_number != null ? Number(r.series_number) : -1
      const seriesLabel = pinnacleSeries
        ? (pinSeries ?? "Unknown")
        : seriesNum >= 0 ? (SERIES_MAP[seriesNum] ?? `Series ${seriesNum}`) : "Unknown"

      if (!tierBreakdown[tier]) tierBreakdown[tier] = { count: 0, fmv: 0 }
      tierBreakdown[tier].count++
      tierBreakdown[tier].fmv += fmv

      if (!seriesBreakdown[seriesLabel]) seriesBreakdown[seriesLabel] = { count: 0, fmv: 0, seriesNumber: seriesNum }
      seriesBreakdown[seriesLabel].count++
      seriesBreakdown[seriesLabel].fmv += fmv

      if (confidenceDist[conf] !== undefined) confidenceDist[conf]++
      else confidenceDist.NO_DATA++

      if (!lockKnown) { lockUnknownCount++; lockUnknownFmv += fmv }
      else if (locked) { lockedCount++; lockedFmv += fmv }
      else { unlockedCount++; unlockedFmv += fmv }
      totalFmv += fmv
    }

    const total = rows.length
    const clarityCount = (confidenceDist.HIGH || 0) + (confidenceDist.MEDIUM || 0)
    const clarityPct = total > 0 ? Math.round((clarityCount / total) * 1000) / 10 : 0

    // Acquisition history is currently only tracked for Top Shot via the Top Shot
    // GraphQL acquisition timeline. For the other collections we have no
    // acquisition source yet, so report nulls instead of misleading zeros.
    const isTopShot = collectionId === TOPSHOT_COLLECTION_ID
    const acqTotal = Number(acqResult.total_moments ?? 0)
    const acquisitionPayload = acquisitionFailed || (!isTopShot && acqTotal === 0)
      ? null
      : {
          pack_pull_count: acqCounts.pack_pull,
          marketplace_count: acqCounts.marketplace,
          challenge_reward_count: acqCounts.challenge_reward,
          gift_count: acqCounts.gift,
          trade_count: acqCounts.trade,
          total_tracked: acqTotal,
        }

    return NextResponse.json({
      wallet,
      collection_id: collectionId,
      acquisition: acquisitionPayload,
      // True when the acquisition read FAILED — distinct from `acquisition:
      // null` meaning "not tracked for this collection".
      acquisition_failed: acquisitionFailed,
      locked: {
        locked_count: lockedCount,
        unlocked_count: unlockedCount,
        locked_fmv: Math.round(lockedFmv * 100) / 100,
        unlocked_fmv: Math.round(unlockedFmv * 100) / 100,
        // Reported, never folded into either side — a bucket nobody can see
        // is the same as not splitting it out at all.
        lock_unknown_count: lockUnknownCount,
        lock_unknown_fmv: Math.round(lockUnknownFmv * 100) / 100,
      },
      tiers: Object.entries(tierBreakdown).map(([tier, v]) => ({ tier, count: v.count, fmv: Math.round(v.fmv * 100) / 100 })).sort((a, b) => b.fmv - a.fmv),
      series: Object.entries(seriesBreakdown).map(([label, v]) => ({ label, seriesNumber: v.seriesNumber, count: v.count, fmv: Math.round(v.fmv * 100) / 100 })).sort((a, b) => a.seriesNumber - b.seriesNumber),
      confidence: confidenceDist,
      total_fmv: Math.round(totalFmv * 100) / 100,
      total_moments: total,
      // The wallet's full size as the source reports it, and whether the
      // figures above cover only part of it (the page cap).
      moments_total: reportedTotal ?? total,
      truncated,
      portfolio_clarity_score: clarityPct,
    })
  } catch (err) {
    console.log("[analytics] error:", err instanceof Error ? err.message : String(err))
    if (err instanceof UsernameLookupUnavailableError) return usernameLookupUnavailableResponse()
    if (err instanceof PublicApiError) {
      // Status stays 500 — that is this route's pre-existing contract, and
      // changing it is a separate decision from not lying about the cause.
      return NextResponse.json(
        { error: err.publicMessage, code: "bad_request", retryable: false },
        { status: 500 }
      )
    }
    return apiErrorResponse(err, "analytics", "Analytics aren't available right now.")
  }
}
