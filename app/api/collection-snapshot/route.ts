import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Backs the public /share/<wallet> card. Delegates to the
// get_wallet_collection_snapshot RPC, which aggregates the wallet's full
// collection server-side in one round-trip (totals + top 5 by FMV + badge
// count + series breakdown). The RPC is required because a plain
// wallet_moments_cache SELECT is capped at 1000 rows by db-max-rows, which
// would undercount any wallet > 1000 moments — i.e. exactly the serious-
// collector cohort this card is meant to convert.
export async function GET(req: NextRequest) {
  const walletRaw = req.nextUrl.searchParams.get("wallet")
  if (!walletRaw || !walletRaw.trim()) {
    return NextResponse.json({ error: "wallet query param is required" }, { status: 400 })
  }
  const wallet = walletRaw.trim()

  try {
    const { data, error } = await supabase.rpc("get_wallet_collection_snapshot", {
      p_wallet: wallet,
    })

    if (error) {
      console.log("[collection-snapshot] rpc error:", error.message)
      return NextResponse.json({ error: "Failed to fetch wallet data" }, { status: 500 })
    }

    const snap = data && typeof data === "object" ? (data as any) : {}

    return NextResponse.json(
      {
        wallet,
        totalMoments: snap.totalMoments ?? 0,
        totalFmv: snap.totalFmv ?? 0,
        topMoments: Array.isArray(snap.topMoments) ? snap.topMoments : [],
        badgeCount: snap.badgeCount ?? 0,
        seriesBreakdown:
          snap.seriesBreakdown && typeof snap.seriesBreakdown === "object"
            ? snap.seriesBreakdown
            : {},
        perCollection: Array.isArray(snap.perCollection) ? snap.perCollection : [],
        rarest: snap.rarest ?? null,
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
        wallet,
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
