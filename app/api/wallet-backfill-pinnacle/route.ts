// app/api/wallet-backfill-pinnacle/route.ts
//
// Disney Pinnacle wallet enricher. ID-only via NonFungibleToken
// CollectionPublic at /public/PinnacleCollection. The Pinnacle ingest
// pipeline owns metadata (character_name, set_name, variant_type) on
// pinnacle_editions; reads JOIN wallet_moments_cache.moment_id at query
// time.

import { NextRequest, NextResponse, after } from "next/server"
import {
  runIdOnlyBackfill,
  resolveWalletInput,
  CADENCE_PINNACLE,
  PINNACLE_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CONFIG = {
  slug: "disney_pinnacle",
  collectionUuid: PINNACLE_COLLECTION_UUID,
  cadenceScript: CADENCE_PINNACLE,
  pipelineName: "wallet-backfill-pinnacle",
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
    await runIdOnlyBackfill({
      config: CONFIG,
      startedAtIso,
      startedMs,
      wallet,
      skipCached,
    })
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
