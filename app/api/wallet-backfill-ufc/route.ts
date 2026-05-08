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
  resolveWalletInput,
  triggerUfcEnrichmentChain,
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
    // Chain into the UFC chain-metadata enricher so wmc rows land with
    // edition_key / player_name / set_name / tier populated rather than
    // sitting NULL. enrich-ufc-wallet is paginated (100 NFTs per page)
    // so we drive it sequentially until done.
    try {
      const result = await triggerUfcEnrichmentChain(wallet)
      console.log(
        `[wallet-backfill-ufc] enrich chain wallet=${wallet} pages=${result.pagesFired} enriched=${result.totalEnriched} done=${result.done}`,
      )
    } catch (err) {
      console.warn(
        `[wallet-backfill-ufc] enrich chain failed wallet=${wallet}: ${err instanceof Error ? err.message : String(err)}`,
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
