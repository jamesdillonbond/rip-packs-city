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

export const dynamic = "force-dynamic"
export const maxDuration = 60

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
