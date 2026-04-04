import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// GET /api/pack-roi?wallet={address}
// Computes pack ROI for a wallet by clustering moments by acquisition time
// and matching clusters to known pack drops.

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000

type PackRipResult = {
  packName: string | null
  dropDate: string | null
  momentsReceived: number
  currentFmv: number
  packCost: number | null
  roi: number | null
  roiPct: number | null
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  if (!wallet) {
    return NextResponse.json({ error: "wallet required" }, { status: 400 })
  }

  try {
    // Fetch wallet moments with acquisition time and FMV
    const { data: moments } = await supabaseAdmin
      .from("wallet_moments_cache")
      .select("edition_id, acquired_at, fmv")
      .eq("wallet_address", wallet)
      .not("acquired_at", "is", null)
      .order("acquired_at", { ascending: true })

    if (!moments || moments.length === 0) {
      return NextResponse.json({ packs: [], message: "No moments found for this wallet" })
    }

    // Cluster moments by acquisition time (within 2 hours = same pack rip)
    const clusters: { timestamp: Date; moments: typeof moments }[] = []
    let currentCluster: typeof moments = []
    let clusterStart: Date | null = null

    for (const m of moments) {
      const acq = new Date(m.acquired_at)
      if (!clusterStart || acq.getTime() - clusterStart.getTime() > TWO_HOURS_MS) {
        if (currentCluster.length >= 2) {
          clusters.push({ timestamp: clusterStart!, moments: currentCluster })
        }
        currentCluster = [m]
        clusterStart = acq
      } else {
        currentCluster.push(m)
      }
    }
    // Push final cluster
    if (currentCluster.length >= 2 && clusterStart) {
      clusters.push({ timestamp: clusterStart, moments: currentCluster })
    }

    if (clusters.length === 0) {
      return NextResponse.json({ packs: [], message: "No pack rip events detected (need 2+ moments acquired together)" })
    }

    // Fetch pack drops for matching
    const { data: packDrops } = await supabaseAdmin
      .from("pack_drops")
      .select("id, name, drop_date, secondary_price")
      .order("drop_date", { ascending: false })

    // Try to match each cluster to a pack drop and fetch pack cost from pack_ev_cache
    const results: PackRipResult[] = []

    for (const cluster of clusters) {
      const totalFmv = cluster.moments.reduce((s: number, m: any) => s + (Number(m.fmv) || 0), 0)

      // Find pack drop within 48 hours of cluster timestamp
      let matchedPack: { name: string; drop_date: string; secondary_price: number | null } | null = null
      if (packDrops) {
        for (const pd of packDrops) {
          if (!pd.drop_date) continue
          const dropTime = new Date(pd.drop_date).getTime()
          const clusterTime = cluster.timestamp.getTime()
          if (Math.abs(clusterTime - dropTime) <= FORTY_EIGHT_HOURS_MS) {
            matchedPack = pd
            break
          }
        }
      }

      // Try pack_ev_cache for cost if we have a matched pack
      let packCost: number | null = matchedPack?.secondary_price ?? null
      if (matchedPack && !packCost) {
        try {
          const { data: evRow } = await supabaseAdmin
            .from("pack_ev_cache")
            .select("pack_price")
            .eq("pack_drop_id", matchedPack.name)
            .single()
          if (evRow?.pack_price) packCost = Number(evRow.pack_price)
        } catch { /* non-fatal */ }
      }

      const roi = packCost ? Number((totalFmv - packCost).toFixed(2)) : null
      const roiPct = packCost && packCost > 0 ? Number((((totalFmv - packCost) / packCost) * 100).toFixed(1)) : null

      results.push({
        packName: matchedPack?.name ?? null,
        dropDate: matchedPack?.drop_date ?? cluster.timestamp.toISOString(),
        momentsReceived: cluster.moments.length,
        currentFmv: Number(totalFmv.toFixed(2)),
        packCost,
        roi,
        roiPct,
      })
    }

    return NextResponse.json(
      { packs: results },
      { headers: { "Cache-Control": "private, max-age=600" } }
    )
  } catch (e) {
    console.error("[pack-roi] Error:", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Pack ROI computation failed" },
      { status: 500 }
    )
  }
}
