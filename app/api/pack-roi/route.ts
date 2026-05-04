import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// GET /api/pack-roi?wallet={address}
// Computes pack ROI for a wallet by clustering moments by acquisition time.

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

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
    const { data: moments } = await supabaseAdmin
      .from("wallet_moments_cache")
      .select("edition_id, acquired_at, fmv")
      .eq("wallet_address", wallet)
      .not("acquired_at", "is", null)
      .order("acquired_at", { ascending: true })

    if (!moments || moments.length === 0) {
      return NextResponse.json({ packs: [], message: "No moments found for this wallet" })
    }

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
    if (currentCluster.length >= 2 && clusterStart) {
      clusters.push({ timestamp: clusterStart, moments: currentCluster })
    }

    if (clusters.length === 0) {
      return NextResponse.json({ packs: [], message: "No pack rip events detected (need 2+ moments acquired together)" })
    }

    const results: PackRipResult[] = clusters.map((cluster) => {
      const totalFmv = cluster.moments.reduce((s: number, m: any) => s + (Number(m.fmv) || 0), 0)
      return {
        packName: null,
        dropDate: cluster.timestamp.toISOString(),
        momentsReceived: cluster.moments.length,
        currentFmv: Number(totalFmv.toFixed(2)),
        packCost: null,
        roi: null,
        roiPct: null,
      }
    })

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
