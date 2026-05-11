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
import { supabaseAdmin } from "@/lib/supabase"
import {
  runPinnacleDetailsBackfill,
  resolveWalletInput,
  PINNACLE_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"

export const dynamic = "force-dynamic"
// 600s ceiling supports the paginated mega-wallet recovery path
// (runPaginatedDetailsBackfill). Single-shot Pinnacle details finish in
// ≤ 60s — only mega-wallets like 0x5f71947aea94eb43 (~7,700 NFTs) trip
// 1110 and need the chunked walk. ~8 chunks × ~15s each ≈ 120s under
// load; 600s is comfortable headroom.
export const maxDuration = 600

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
  // even ones already in wmc. The post-pass JOIN against pinnacle_editions
  // then fills character_name/set_name/tier/mint_count on the same rows.
  // This is the unblock for stable wallets that exited the cron pass via
  // no_more_moments without ever getting their existing rows enriched.
  const forceParam = req.nextUrl.searchParams.get("force")
  const force = body.force === true || forceParam === "true" || forceParam === "1"
  const skipCached = force ? false : body.skip_cached !== false

  const startedMs = Date.now()
  const startedAtIso = new Date(startedMs).toISOString()

  // Sync-mode contract mirrors wallet-backfill-allday — see comment there
  // for the full spec.
  const sync = req.nextUrl.searchParams.get("sync") === "true"
  if (sync) {
    const maxDurationMs = Math.max(
      30_000,
      Math.min(540_000, Number(req.nextUrl.searchParams.get("max_duration_ms") ?? "270000")),
    )
    const checkpointParam = req.nextUrl.searchParams.get("checkpoint")
    const startIndex = checkpointParam && /^\d+$/.test(checkpointParam) ? Number(checkpointParam) : undefined
    const softDeadlineAt = startedMs + maxDurationMs

    const result = await runPinnacleDetailsBackfill({
      config: CONFIG,
      startedAtIso,
      startedMs,
      wallet,
      skipCached,
      force,
      softDeadlineAt,
      startIndex,
    })
    try {
      await (supabaseAdmin as any).rpc("record_wallet_backfill_scan", {
        p_wallet: wallet,
        p_collection_slug: CONFIG.slug,
        p_found_count: result.rowsFound,
      })
    } catch (err) {
      console.warn(
        `[${CONFIG.pipelineName}] record_wallet_backfill_scan failed wallet=${wallet}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return NextResponse.json({
      ok: true,
      mode: "sync",
      collection: CONFIG.slug,
      wallet_address: wallet,
      input: rawInput,
      skip_cached: skipCached,
      force,
      started_at: startedAtIso,
      complete: result.complete,
      next_checkpoint: result.nextStartIndex == null ? null : String(result.nextStartIndex),
      rows_processed: result.rowsFound,
      max_duration_ms: maxDurationMs,
    })
  }

  after(async () => {
    const { rowsFound } = await runPinnacleDetailsBackfill({
      config: CONFIG,
      startedAtIso,
      startedMs,
      wallet,
      skipCached,
      force,
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
      force,
      started_at: startedAtIso,
    },
    { status: 202 }
  )
}
