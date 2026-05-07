// app/api/wallet-backfill-golazos/route.ts
//
// LaLiga Golazos wallet enricher. ID-only via NonFungibleToken
// CollectionPublic at /public/GolazoNFTCollection. Golazos has the
// thinnest secondary-market liquidity of the five collections; the
// editions table is sparse, so most rows here will read with player /
// set null until the Golazos ingest pipeline catches up.

import { NextRequest, NextResponse, after } from "next/server"
import {
  runIdOnlyBackfill,
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

  const wallet = body.wallet?.trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet field required" }, { status: 400 })
  }
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
      skip_cached: skipCached,
      started_at: startedAtIso,
    },
    { status: 202 }
  )
}
