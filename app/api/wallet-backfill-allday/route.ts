// app/api/wallet-backfill-allday/route.ts
//
// AllDay wallet enricher — calls runAllDayDetailsBackfill (NOT the generic
// runIdOnlyBackfill) so each wmc row lands with edition_key + serial_number
// populated from a single GET_UNLOCKED_MOMENT_DETAILS Cadence call. After
// the upsert, the helper triggers a SQL JOIN backfill against editions to
// fill tier / player_name / set_name. Pre-2026-05-07 this route used
// runIdOnlyBackfill which left 98.5% of rows NULL on those four columns.

import { NextRequest, NextResponse, after } from "next/server"
import {
  runAllDayDetailsBackfill,
  resolveWalletInput,
  ALLDAY_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"

export const dynamic = "force-dynamic"
export const maxDuration = 120

// cadenceScript on the config is unused by runAllDayDetailsBackfill —
// it calls GET_UNLOCKED_MOMENT_DETAILS directly. Kept on the config shape
// only because BackfillCollectionConfig requires it.
const CONFIG = {
  slug: "nfl_all_day",
  collectionUuid: ALLDAY_COLLECTION_UUID,
  cadenceScript: "",
  pipelineName: "wallet-backfill-allday",
} as const

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { wallet?: string; skip_cached?: boolean; force?: boolean }
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
  // force=true (?force=true OR {force: true}) bypasses the cached-id filter
  // so chain enrichment writes edition_key + serial on every on-chain row,
  // even ones already in wmc. The post-pass JOIN against editions then
  // fills tier/player_name/set_name/team_name on the same rows. Use this
  // to unblock stable wallets whose wmc rows were created before chain
  // enrichment shipped (~2026-05-07). Do NOT force on mega-wallets
  // (>5k AllDay moments) — they'll likely trip the access-API
  // computation-limit handler and need pagination.
  const forceParam = req.nextUrl.searchParams.get("force")
  const force = body.force === true || forceParam === "true" || forceParam === "1"
  const skipCached = force ? false : body.skip_cached !== false

  const startedMs = Date.now()
  const startedAtIso = new Date(startedMs).toISOString()

  after(async () => {
    await runAllDayDetailsBackfill({
      config: CONFIG,
      startedAtIso,
      startedMs,
      wallet,
      skipCached,
      force,
    })
  })

  return NextResponse.json(
    {
      accepted: true,
      collection: CONFIG.slug,
      wallet_address: wallet,
      input: rawInput,
      skip_cached: skipCached,
      force,
      started_at: startedAtIso,
    },
    { status: 202 }
  )
}
