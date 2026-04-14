import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/topshot"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

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
  const data = await topshotGraphql<UsernameProfileResponse>(query, { username: t.replace(/^@+/, "") })
  const raw = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
  if (!raw) throw new Error("Could not resolve username to wallet address.")
  return raw.startsWith("0x") ? raw : `0x${raw}`
}

export async function GET(req: NextRequest) {
  try {
    const walletInput = req.nextUrl.searchParams.get("wallet")
    if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const wallet = await resolveWallet(walletInput)
    const collectionId = req.nextUrl.searchParams.get("collection_id") || TOPSHOT_COLLECTION_ID

    // Acquisition stats via RPC
    const { data: acqRaw } = await (supabaseAdmin as any).rpc("get_acquisition_stats", {
      p_wallet: wallet,
      p_collection_id: collectionId,
    })
    const acqResult = (Array.isArray(acqRaw) ? acqRaw[0] : acqRaw) ?? {}
    const acqCounts: Record<string, number> = { pack_pull: 0, marketplace: 0, challenge_reward: 0, gift: 0 }
    for (const b of (acqResult.breakdown as Array<{ method: string; count: number }> | undefined) ?? []) {
      if (b?.method && acqCounts[b.method] !== undefined) acqCounts[b.method] = Number(b.count) || 0
    }

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
    const confidenceDist: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, NO_DATA: 0, ASK_ONLY: 0, STALE: 0 }
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

    return NextResponse.json({
      wallet,
      collection_id: collectionId,
      acquisition: {
        pack_pull_count: acqCounts.pack_pull,
        marketplace_count: acqCounts.marketplace,
        challenge_reward_count: acqCounts.challenge_reward,
        gift_count: acqCounts.gift,
        total_tracked: Number(acqResult.total_moments ?? 0),
      },
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
    return NextResponse.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 })
  }
}
