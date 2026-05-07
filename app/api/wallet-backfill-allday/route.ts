// app/api/wallet-backfill-allday/route.ts
//
// AllDay wallet enricher — thin wrapper over the shared
// runIdOnlyBackfill helper. See lib/wallet-backfill-helpers.ts for the
// runner, the cache-diff logic, and the rationale for ID-only writes.

import { NextRequest, NextResponse, after } from "next/server"
import {
  runIdOnlyBackfill,
  CADENCE_ALLDAY,
  ALLDAY_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"
import { supabaseAdmin } from "@/lib/supabase"
import {
  isWalletAddress,
  resolveTopShotUsernameCacheAware,
} from "@/lib/topshot-username-resolve"

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
  const skipCached = body.skip_cached !== false

  // Resolve username → 0x via the shared TopShot resolver. Dapper SSO maps
  // username → wallet for all four collections, so a TopShot resolution is
  // authoritative for AllDay too. Skipping this step caused Flow to reject
  // raw usernames with "invalid address prefix: expected 0x, got ja".
  let wallet: string
  if (isWalletAddress(rawInput)) {
    wallet = rawInput.startsWith("0x") ? rawInput : `0x${rawInput}`
  } else {
    const outcome = await resolveTopShotUsernameCacheAware(supabaseAdmin, rawInput)
    if (!outcome.found) {
      return NextResponse.json(
        { error: "could not resolve username", input: rawInput, reason: outcome.reason },
        { status: 400 }
      )
    }
    wallet = outcome.walletAddress
  }

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
