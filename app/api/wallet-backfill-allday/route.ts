// app/api/wallet-backfill-allday/route.ts
//
// AllDay wallet enricher — thin wrapper over the shared
// runIdOnlyBackfill helper. See lib/wallet-backfill-helpers.ts for the
// runner, the cache-diff logic, and the rationale for ID-only writes.

import { NextRequest, NextResponse, after } from "next/server"
import {
  runIdOnlyBackfill,
  resolveWalletInput,
  CADENCE_ALLDAY,
  ALLDAY_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const CONFIG = {
  slug: "nfl_all_day",
  collectionUuid: ALLDAY_COLLECTION_UUID,
  cadenceScript: CADENCE_ALLDAY,
  pipelineName: "wallet-backfill-allday",
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
