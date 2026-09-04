import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/chains/flow/topshot"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { bucketAcquisitionCounts } from "@/lib/analytics/shape"
import { apiErrorResponse } from "@/lib/api-error"
import { lookupCachedTopShotUsername } from "@/lib/chains/flow/topshot-username-resolve"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
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

type UsernameProfileResponse = {
  getUserProfileByUsername?: { publicInfo?: { flowAddress?: string | null } | null } | null
}

async function resolveWallet(input: string): Promise<string> {
  const t = input.trim()
  if (t.startsWith("0x") && t.length === 18) return t
  const query = `
    query GetUserProfileByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress }
      }
    }
  `
  // 2026-09-04: the cached username ladder FIRST (the live host below is dead — see lookupCachedTopShotUsername).
  const cachedWallet = await lookupCachedTopShotUsername(supabaseAdmin as any, t)
  if (cachedWallet) return cachedWallet
  const data = await topshotGraphql<UsernameProfileResponse>(query, { username: t.replace(/^@+/, "") })
  const raw = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
  if (!raw) throw new PublicApiError("Could not resolve username to wallet address.")
  return raw.startsWith("0x") ? raw : `0x${raw}`
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

function resolveCollectionId(raw: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // UUID passed directly — accept if it's one of ours.
  if (VALID_UUIDS.has(trimmed)) return trimmed
  // Slug (hyphen-style: nba-top-shot, nfl-all-day, etc).
  const uuid = COLLECTION_UUID_BY_SLUG[trimmed]
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

    // Acquisition stats via RPC
    const { data: acqRaw } = await (supabaseAdmin as any).rpc("get_acquisition_stats", {
      p_wallet: wallet,
      p_collection_id: collectionId,
    })
    const acqResult = (Array.isArray(acqRaw) ? acqRaw[0] : acqRaw) ?? {}
    const acqCounts = bucketAcquisitionCounts(
      acqResult.breakdown as Array<{ method?: string | null; count?: number | null }> | undefined
    )

    // Wallet moments (page 1, large limit) via get_wallet_moments_with_fmv — returns tier/series/is_locked/fmv/confidence
    const PAGE_SIZE = 1000
    const rows: any[] = []
    for (let page = 0; page < 10; page++) {
      const { data } = await (supabaseAdmin as any).rpc("get_wallet_moments_with_fmv", {
        p_wallet: wallet,
        p_sort_by: "fmv_desc",
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
        p_player: null,
        p_series: null,
        p_tier: null,
        p_collection_id: collectionId,
      })
      const result = (Array.isArray(data) ? data[0] : data) as { moments?: any[]; total_count?: number } | null
      const batch = result?.moments ?? []
      rows.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }

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
    let totalFmv = 0

    for (const r of rows) {
      const tier = (r.tier ? String(r.tier).replace(/^MOMENT_TIER_/i, "").toUpperCase() : "UNKNOWN")
      const fmv = r.fmv_usd != null ? Number(r.fmv_usd) : 0
      const locked = r.is_locked === true
      const conf = (r.confidence ? String(r.confidence).toUpperCase() : "NO_DATA")
      const seriesNum = r.series_number != null ? Number(r.series_number) : -1
      const seriesLabel = seriesNum >= 0 ? (SERIES_MAP[seriesNum] ?? `Series ${seriesNum}`) : "Unknown"

      if (!tierBreakdown[tier]) tierBreakdown[tier] = { count: 0, fmv: 0 }
      tierBreakdown[tier].count++
      tierBreakdown[tier].fmv += fmv

      if (!seriesBreakdown[seriesLabel]) seriesBreakdown[seriesLabel] = { count: 0, fmv: 0, seriesNumber: seriesNum }
      seriesBreakdown[seriesLabel].count++
      seriesBreakdown[seriesLabel].fmv += fmv

      if (confidenceDist[conf] !== undefined) confidenceDist[conf]++
      else confidenceDist.NO_DATA++

      if (locked) { lockedCount++; lockedFmv += fmv } else { unlockedCount++; unlockedFmv += fmv }
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
    const acquisitionPayload = !isTopShot && acqTotal === 0
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
      locked: {
        locked_count: lockedCount,
        unlocked_count: unlockedCount,
        locked_fmv: Math.round(lockedFmv * 100) / 100,
        unlocked_fmv: Math.round(unlockedFmv * 100) / 100,
      },
      tiers: Object.entries(tierBreakdown).map(([tier, v]) => ({ tier, count: v.count, fmv: Math.round(v.fmv * 100) / 100 })).sort((a, b) => b.fmv - a.fmv),
      series: Object.entries(seriesBreakdown).map(([label, v]) => ({ label, seriesNumber: v.seriesNumber, count: v.count, fmv: Math.round(v.fmv * 100) / 100 })).sort((a, b) => a.seriesNumber - b.seriesNumber),
      confidence: confidenceDist,
      total_fmv: Math.round(totalFmv * 100) / 100,
      total_moments: total,
      portfolio_clarity_score: clarityPct,
    })
  } catch (err) {
    console.log("[analytics] error:", err instanceof Error ? err.message : String(err))
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
