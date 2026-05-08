// app/api/wallet-backfill-pinnacle/route.ts
//
// Disney Pinnacle wallet enricher. Calls runPinnacleDetailsBackfill (NOT
// the generic runIdOnlyBackfill) so each wmc row lands with edition_key +
// serial_number populated from a single Cadence call that walks every
// owned NFT and derives editionKey from MetadataViews traits
// (RoyaltyCodes:Variant:Printing). After the upsert, a SQL JOIN backfill
// against pinnacle_editions fills character_name / set_name / tier
// (= variant_type) / mint_count.
//
// Pre-2026-05-07 this route used runIdOnlyBackfill which left ~99.4% of
// rows with NULL edition_key on Trevor's wallet (1/180) because the only
// edition_key resolver path (pinnacle-nft-resolver edge function) was
// triggered by recent on-chain Deposit events — stable holdings never
// fired. Mirror of the AllDay/UFC chain-enrichment fix shipped 2026-05-07.

import { NextRequest, NextResponse, after } from "next/server"
import {
  runPinnacleDetailsBackfill,
  resolveWalletInput,
  PINNACLE_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"

export const dynamic = "force-dynamic"
export const maxDuration = 120

// cadenceScript on the config is unused by runPinnacleDetailsBackfill —
// it calls GET_PINNACLE_UNLOCKED_DETAILS directly. Kept on the config
// shape only because BackfillCollectionConfig requires it.
const CONFIG = {
  slug: "disney_pinnacle",
  collectionUuid: PINNACLE_COLLECTION_UUID,
  cadenceScript: "",
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
    await runPinnacleDetailsBackfill({
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
