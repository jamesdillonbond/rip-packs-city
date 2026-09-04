import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
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
      // apiErrorResponse rather than a hand-rolled 500: it classifies a
      // statement timeout as a retryable 503 instead of burning the hard-5xx
      // budget, and it sets `no-store` so a blip is not pinned at the CDN for
      // the rest of this route's 300s TTL.
      return apiErrorResponse(error, "api/collection-snapshot", "Failed to fetch wallet data")
    }

    const snap = data && typeof data === "object" ? (data as any) : {}

    return NextResponse.json(
      {
        wallet,
        totalMoments: snap.totalMoments ?? 0,
        totalFmv: snap.totalFmv ?? 0,
        topMoments: Array.isArray(snap.topMoments) ? snap.topMoments : [],
        badgeCount: snap.badgeCount ?? 0,
        // 2026-09-04: the stale split (editions → edition_fmv_current, STALE) so
        // the card can headline total − stale like every other public surface.
        staleFmv: typeof snap.staleFmv === "number" ? snap.staleFmv : Number(snap.staleFmv ?? 0) || 0,
        staleCount: typeof snap.staleCount === "number" ? snap.staleCount : Number(snap.staleCount ?? 0) || 0,
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
    // 🚨 THIS BRANCH USED TO RETURN **200** WITH ZEROS, AND IT DEFEATED THE
    // HONESTY FIX IN EVERY ONE OF ITS FIVE CONSUMERS.
    //
    // It returned `{ totalMoments: 0, totalFmv: 0, ..., error }` with NO status
    // (so: 200) under `public, s-maxage=60` — a failed read, held at the CDN and
    // served to everyone for a minute. Each consumer discriminates on `res.ok`,
    // exactly as CLAUDE.md's honesty table prescribes, and `res.ok` is TRUE for
    // a 200. So the fixes were correct at the layer they were written for and
    // could never fire for the failure that actually happens:
    //
    //   /api/og/share       → `fetched = true` → publishes "$0.00 / 0 moments"
    //                         for a NAMED wallet, baked into an edge-cached PNG
    //                         and posted to social. Its own comment says that
    //                         false financial claim is what it was fixed to stop.
    //   /share/<wallet>     → "We haven't indexed this wallet yet" — a claim
    //                         about OUR INDEX from a transient failure — and the
    //                         empty state QUEUES the wallet and polls, so an
    //                         outage spends real ingest work re-indexing wallets
    //                         that were already fine. Also documented in-file.
    //   ShareEmptyState     → polls its whole budget, then "retry"; never learns
    //                         the read failed.
    //   SniperClient        → `topMoments: []` is TRUTHY, so `owned = []` and the
    //                         suggestions panel concludes rather than reporting.
    //   support-chat        → `!res.ok` never throws, so the concierge answers
    //                         "Your collection: 0 moments, total FMV $0.00" —
    //                         the rule it breaks is its own: an errored tool is
    //                         NOT an empty result.
    //
    // ⚠ Fixing the PRODUCER repairs all five without touching any of them. The
    // shape to remember: when several consumers each carry a careful `res.ok`
    // check, the thing worth auditing is whether the producer can ever answer
    // not-ok.
    return apiErrorResponse(err, "api/collection-snapshot", "Failed to fetch wallet data")
  }
}
