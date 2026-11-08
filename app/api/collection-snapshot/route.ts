import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { createClient } from "@supabase/supabase-js"
import { walletIndexState } from "@/lib/wallet-indexed"

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
// #228 lever (b′), 2026-11-04: a 20 s read budget for THIS route, not the 8 s default.
// The largest wallets (24 hold ≥ 20k Moments, max 70k) read cache-cold in 8–12 s under IO pressure.
// pg_stat_statements held calls of 8.4 s and 11.3 s that COMPLETED in the database after this route
// had already answered 503 — boundedRead abandons the wait, not the query — so the 8 s bound was
// turning a slow success into an error, and the first visitor paid for it while the page warmed
// for the next one. 20 s sits under the service_role statement_timeout (30 s) and this route's
// maxDuration, so a genuinely stuck read is still reported by us, honestly, as a retryable 503.
// The share page's server fetch carries no deadline of its own; the OG card's ogFetch (10 s) does
// and is unaffected. A lever that needs no new schedule and covers every wallet, not a top-N list.
const SNAPSHOT_READ_BUDGET_MS = 20_000
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const walletRaw = req.nextUrl.searchParams.get("wallet")
  if (!walletRaw || !walletRaw.trim()) {
    return NextResponse.json({ error: "wallet query param is required" }, { status: 400 })
  }
  const wallet = walletRaw.trim()

  try {
    const { data, error } = await boundedRead(supabase.rpc("get_wallet_collection_snapshot", {
      p_wallet: wallet,
    }), "api/collection-snapshot/get_wallet_collection_snapshot", SNAPSHOT_READ_BUDGET_MS)

    if (error) {
      // apiErrorResponse rather than a hand-rolled 500: it classifies a
      // statement timeout as a retryable 503 instead of burning the hard-5xx
      // budget, and it sets `no-store` so a blip is not pinned at the CDN for
      // the rest of this route's 300s TTL.
      return apiErrorResponse(error, "api/collection-snapshot", "Failed to fetch wallet data")
    }

    const snap = data && typeof data === "object" ? (data as any) : {}
    // ⚠ AN EMPTY SNAPSHOT IS TRANSITIONAL — never pin it at the CDN (2026-10-22). /share/<wallet>
    // renders ShareEmptyState on 0 moments, which queues indexing and polls THIS route with a
    // cache-buster; when the poll sees moments it reloads, and the page's server fetch (through the
    // site URL, so through the CDN) got the cached 0 back for up to s-maxage=300 (+ SWR) — so the
    // page reloaded every ~9 s. Measured live 10-21: a Google visitor's own share card reloaded 36
    // times in 6 minutes (72 "share views" that week came from 6 browsers).
    const isEmpty = (Number(snap.totalMoments) || 0) === 0
    // #237 (2026-11-08): an empty snapshot is either a wallet that holds nothing or one
    // RPC has never walked — say which. `indexed`: true (walked, or holds moments),
    // false (never walked), null (could not tell). Never blocks the answer.
    let indexed: boolean | null = true
    if (isEmpty) {
      try {
        const st = await walletIndexState(supabase, wallet)
        indexed = st.ok ? st.indexed : null
      } catch {
        indexed = null
      }
    }
    // #228 lever (b), 2026-11-08: a long STALE window, so the CDN answers a whale's card at once and
    // recomputes in the background. Fresh stays 5 min. Measured: the 11-07 timeout was 0xf5d1b36f…
    // (53.6k Moments), whose four slow reads that day (17 s, 11 s, 23.9 s → the 20 s timeout, 12 s)
    // came 19 min, 5 h and 53 min apart — every one past the old 10-min stale window, so every one
    // ran cold in front of the visitor. 6 h is the wallet cache's own staleness bound (the Sentinel's
    // Portfolio Cache Drain warns at 12 h), and the payload's generatedAt is stamped at compute time,
    // so a copy served stale still says when it was true. A failed or empty read is never stored here
    // (apiErrorResponse → no-store; isEmpty → no-store), so the window can only hold a success.

    return NextResponse.json(
      {
        wallet,
        totalMoments: snap.totalMoments ?? 0,
        indexed,
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
        // 2026-09-24: ordered, one-collection series bars + which collection.
        seriesBars: Array.isArray(snap.seriesBars) ? snap.seriesBars : [],
        seriesCollection:
          snap.seriesCollection && typeof snap.seriesCollection === "object" ? snap.seriesCollection : null,
        perCollection: Array.isArray(snap.perCollection) ? snap.perCollection : [],
        rarest: snap.rarest ?? null,
        generatedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": isEmpty ? "no-store" : "public, s-maxage=300, stale-while-revalidate=21600",
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
