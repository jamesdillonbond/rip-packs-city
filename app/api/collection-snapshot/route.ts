import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  if (!wallet || !wallet.trim()) {
    return NextResponse.json({ error: "wallet query param is required" }, { status: 400 })
  }

  try {
    // Fetch wallet moments from cache
    const { data: moments, error: momentsErr } = await supabase
      .from("wallet_moments_cache")
      .select("player_name, set_name, tier, serial_number, edition_id, thumbnail_url, series")
      .eq("wallet_address", wallet.trim())

    if (momentsErr) {
      console.log("[collection-snapshot] wallet_moments_cache error:", momentsErr.message)
      return NextResponse.json({ error: "Failed to fetch wallet data" }, { status: 500 })
    }

    const rows = moments ?? []
    const totalMoments = rows.length

    // Get edition IDs for FMV lookup
    const editionIds = [...new Set(rows.map((r: any) => r.edition_id).filter(Boolean))]

    // Fetch latest FMV for each edition
    let fmvMap: Record<string, number> = {}
    if (editionIds.length > 0) {
      const { data: fmvRows } = await supabase
        .from("fmv_snapshots")
        .select("edition_id, fmv_usd, computed_at")
        .in("edition_id", editionIds)
        .order("computed_at", { ascending: false })

      // Keep only the latest per edition
      for (const row of fmvRows ?? []) {
        if (!fmvMap[row.edition_id]) {
          fmvMap[row.edition_id] = Number(row.fmv_usd) || 0
        }
      }
    }

    // Calculate total FMV
    let totalFmv = 0
    const momentsWithFmv = rows.map((r: any) => {
      const fmv = fmvMap[r.edition_id] ?? 0
      totalFmv += fmv
      return { ...r, fmv }
    })

    // Top 5 by FMV
    const topMoments = momentsWithFmv
      .sort((a: any, b: any) => (b.fmv ?? 0) - (a.fmv ?? 0))
      .slice(0, 5)
      .map((m: any) => ({
        playerName: m.player_name,
        setName: m.set_name,
        tier: m.tier,
        serial: m.serial_number,
        fmv: m.fmv,
        thumbnailUrl: m.thumbnail_url,
      }))

    // Badge count
    const { count: badgeCount } = await supabase
      .from("badge_editions")
      .select("id", { count: "exact", head: true })
      .in("edition_id", editionIds.length > 0 ? editionIds : ["__none__"])

    // Series breakdown
    const seriesBreakdown: Record<string, number> = {}
    for (const r of rows) {
      const s = r.series ?? "Unknown"
      const label = `S${s}`
      seriesBreakdown[label] = (seriesBreakdown[label] ?? 0) + 1
    }

    return NextResponse.json(
      {
        wallet: wallet.trim(),
        totalMoments,
        totalFmv: Math.round(totalFmv * 100) / 100,
        topMoments,
        badgeCount: badgeCount ?? 0,
        seriesBreakdown,
        generatedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    )
  } catch (err: any) {
    console.error("[collection-snapshot] error:", err?.message ?? err)
    return NextResponse.json(
      {
        wallet: wallet.trim(),
        totalMoments: 0,
        totalFmv: 0,
        topMoments: [],
        badgeCount: 0,
        seriesBreakdown: {},
        generatedAt: new Date().toISOString(),
        error: err?.message ?? "Internal server error",
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
        },
      }
    )
  }
}
