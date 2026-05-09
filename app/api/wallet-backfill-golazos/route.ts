// app/api/wallet-backfill-golazos/route.ts
//
// LaLiga Golazos wallet enricher. ID-only via NonFungibleToken
// CollectionPublic at /public/GolazoNFTCollection. Golazos has the
// thinnest secondary-market liquidity of the five collections; the
// editions table is sparse, so most rows here will read with player /
// set null until the Golazos ingest pipeline catches up.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  runIdOnlyBackfill,
  resolveWalletInput,
  CADENCE_GOLAZOS,
  GOLAZOS_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CONFIG = {
  slug: "laliga_golazos",
  collectionUuid: GOLAZOS_COLLECTION_UUID,
  cadenceScript: CADENCE_GOLAZOS,
  pipelineName: "wallet-backfill-golazos",
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
    const { rowsFound } = await runIdOnlyBackfill({
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
