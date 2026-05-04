import { NextResponse } from "next/server"

// ── DEPRECATED 2026-05-03 ───────────────────────────────────────────────────
//
// The inline-borrow strategy this route used had a 0% borrow hit rate every
// run after April 28: AllDay NFTs transfer out of Flowty escrow on purchase
// AND out of the buyer's main wallet (to vaults / sub-accounts) before the
// hourly cron caught up, so a borrow against any candidate owner returns
// nothing. The unmapped_sales backlog grew from 1,689 (Apr 28) to 2,747
// (May 3) at ~176 unresolved sales per day.
//
// Same architectural problem as the Pinnacle 653-row backlog. The fix is a
// historical Flow spork scan via port 8070 on the access-001.mainnetN nodes
// — that pulls the buyer from the on-chain ListingCompleted/Purchase event
// payload, which is the authoritative record regardless of post-sale
// transfers. Tracked as a future unified spork-scan resolver (one edge
// function serving both AllDay + Pinnacle, parameterised by contract addr +
// event signature + target table).
//
// Stubbed to 410 here so pipeline_runs doesn't accumulate stale rows if the
// hourly cron-job.org schedule gets re-enabled before the new resolver ships.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET() {
  return NextResponse.json(
    {
      error: "gone",
      reason: "resolve-allday-buyers retired 2026-05-03 (0% borrow hit rate after Apr 28); awaiting unified spork-scan resolver",
    },
    { status: 410 }
  )
}
