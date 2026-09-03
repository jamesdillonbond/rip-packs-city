// app/api/wallet-backfill-golazos/route.ts
//
// LaLiga Golazos wallet enricher. Calls runAllDayDetailsBackfill (NOT the
// generic runIdOnlyBackfill) with a Golazos details script, so each wmc row
// lands with edition_key + serial_number populated.
//
// Why this changed (2026-07-31): runIdOnlyBackfill writes edition_key: null
// by design, on the premise that "out-of-band edition resolvers populate
// player/set/tier and reads JOIN at query time" — but nothing can JOIN to
// editions without an edition_key, and only 0.0% of these rows were
// recoverable from the moments table. Result: 9,494 / 9,494 Golazos wmc rows
// (100%, all 115 wallets) had edition_key NULL and rendered with no player /
// set / tier / FMV. This is the identical defect already found and fixed for
// AllDay (was 98.5% NULL) and Pinnacle (was ~99.4% NULL, 2026-05-07); Golazos
// and UFC were the two collections left behind on the broken path.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  runAllDayDetailsBackfill,
  resolveWalletInput,
  CADENCE_GOLAZOS,
  GET_GOLAZOS_MOMENT_DETAILS,
  GOLAZOS_COLLECTION_UUID,
} from "@/lib/chains/flow/wallet-backfill-helpers"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

export const dynamic = "force-dynamic"
// 🚨 RAISED 60 -> 600 ON 2026-09-03, AND THE 60 WAS INHERITED RATHER THAN CHOSEN.
//
// This route was the fleet's top source of wall kills: **6 `Vercel Runtime
// Timeout Error: Task timed out after 60 seconds` in the 24 h to 2026-09-03
// 08:00Z, more than every other route on the platform combined** (evm-transfers
// -ingest 1, fmv-recalc 1, sniper-feed 3). Its three sibling wallet enrichers
// took ZERO in the same window — and they run at **600 s (allday), 600 s
// (pinnacle) and 300 s (ufc)**.
//
// ⭐ THE HISTORY SAYS OVERSIGHT, NOT DECISION. `1791e9083` (2026-05-06) created
// all four with `maxDuration = 60`; `d57349c5a` (2026-05-08) raised AllDay to
// 600 for "paginated mega-wallet recovery" and the others followed. This one did
// not. It was then switched to `runAllDayDetailsBackfill` — **the same runner
// AllDay uses**, per this file's header — so it took on the heavier work and
// kept the lighter wall. 600 matches the sibling running the identical function.
//
// ⚠ A killed tick is 100% waste: `after()` is terminated with its terminal row
// unwritten, so the wallet is neither enriched nor recorded as failed. Raising
// the wall costs compute only on the runs that were being thrown away.
// ⭐ FALSIFIER: if ticks now run past ~300 s the work itself is pathological and
// the fix is inside `runAllDayDetailsBackfill`, not here. The marker below is
// what makes that measurable — before it, a kill here was recorded nowhere.
export const maxDuration = 600

// cadenceScript (the ID-only walk) is retained but unused by the details
// runner — kept so a revert to runIdOnlyBackfill is a one-line change.
const CONFIG = {
  slug: "laliga_golazos",
  collectionUuid: GOLAZOS_COLLECTION_UUID,
  cadenceScript: CADENCE_GOLAZOS,
  detailsCadence: GET_GOLAZOS_MOMENT_DETAILS,
  detailsMode: "details_golazos",
  pipelineName: "wallet-backfill-golazos",
  // A zero-moment scan for a wallet that still has cached Golazos rows is a
  // failed read (nil capability borrow), NOT an empty wallet — log it ok:false
  // so it is never masked as 'no_more_moments'. See the empty-scan honesty guard
  // in runAllDayDetailsBackfill (2026-08-04).
  flagEmptyWithCachedHoldings: true,
} as const

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { wallet?: string; skip_cached?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const rawInput = body.wallet?.trim()
  if (!rawInput) {
    return NextResponse.json({ error: "wallet field required" }, { status: 400 })
  }
  const resolved = await resolveWalletInput(rawInput)
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error, input: resolved.input, reason: resolved.reason },
      { status: 400 }
    )
  }
  const wallet = resolved.wallet
  const skipCached = body.skip_cached !== false

  const startedMs = Date.now()
  const startedAtIso = new Date(startedMs).toISOString()

  after(async () => {
    // ⚠ THE INVOCATION MARKER. Its terminal `pipeline_runs` row is written by
    // `runAllDayDetailsBackfill` in `lib/chains/flow/wallet-backfill-helpers.ts`,
    // NOT here — which is exactly why this route was invisible to
    // `__tests__/after-route-heartbeat-ratchet.test.ts` until 2026-09-03: that
    // guard derived its population from each ROUTE FILE's own text, so a route
    // whose terminal write is one delegation away was outside it BY
    // CONSTRUCTION. Fourth instance of that shape in this repo.
    //
    // ⭐ And it was not a hypothetical gap: six wall kills in 24 h landed here,
    // recorded by NOTHING. `try/catch` cannot catch a `maxDuration` kill, and
    // without this row a killed tick is indistinguishable from a wallet nobody
    // ever asked to enrich.
    await writeInvocationHeartbeat({
      pipeline: CONFIG.pipelineName,
      startedAtMs: startedMs,
      collectionSlug: CONFIG.slug,
      extra: { wallet, skip_cached: skipCached },
    })
    const { rowsFound } = await runAllDayDetailsBackfill({
      config: CONFIG,
      startedAtIso,
      startedMs,
      wallet,
      skipCached,
    })
    try {
      await (supabaseAdmin as any).rpc("record_wallet_backfill_scan", {
        p_wallet: wallet,
        p_collection_slug: CONFIG.slug,
        p_found_count: rowsFound,
      })
    } catch (err) {
      console.warn(
        `[${CONFIG.pipelineName}] record_wallet_backfill_scan failed wallet=${wallet}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })

  return NextResponse.json(
    {
      accepted: true,
      collection: CONFIG.slug,
      wallet_address: wallet,
      input: rawInput,
      skip_cached: skipCached,
      started_at: startedAtIso,
    },
    { status: 202 }
  )
}
