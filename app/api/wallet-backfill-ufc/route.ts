// app/api/wallet-backfill-ufc/route.ts
//
// UFC Strike wallet enricher. ID-only via NonFungibleToken
// CollectionPublic at /public/UFC_NFTCollection. UFC migrated to Aptos
// per the April 2026 session note in CLAUDE.md, so the on-chain Flow
// data is essentially frozen — this enricher captures whatever Flow-side
// holdings exist for invitees who collected UFC pre-migration.

import { NextRequest, NextResponse, after } from "next/server"
import {
  runIdOnlyBackfill,
  CADENCE_UFC,
  UFC_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CONFIG = {
  slug: "ufc_strike",
  collectionUuid: UFC_COLLECTION_UUID,
  cadenceScript: CADENCE_UFC,
  pipelineName: "wallet-backfill-ufc",
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
