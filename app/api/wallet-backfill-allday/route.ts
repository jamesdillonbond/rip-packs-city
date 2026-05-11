// app/api/wallet-backfill-allday/route.ts
//
// AllDay wallet enricher — calls runAllDayDetailsBackfill (NOT the generic
// runIdOnlyBackfill) so each wmc row lands with edition_key + serial_number
// populated from a single GET_UNLOCKED_MOMENT_DETAILS Cadence call. After
// the upsert, the helper triggers a SQL JOIN backfill against editions to
// fill tier / player_name / set_name. Pre-2026-05-07 this route used
// runIdOnlyBackfill which left 98.5% of rows NULL on those four columns.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  runAllDayDetailsBackfill,
  resolveWalletInput,
  ALLDAY_COLLECTION_UUID,
} from "@/lib/wallet-backfill-helpers"

export const dynamic = "force-dynamic"
// 600s ceiling supports the paginated mega-wallet recovery path
// (runPaginatedDetailsBackfill). Single-shot details calls finish in
// ≤ 30s — only the 1110/access-API-500 fall-through to the 1000-NFT
// chunked walk needs the full ceiling. AllDay top wallets are 40k+
// moments → ~44 chunks × ~10s each ≈ 450s of wall-clock under load.
export const maxDuration = 600

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

  // Sync-mode (added 2026-05-10 to resolve pool saturation root cause):
  // when ?sync=true, run inline + return a checkpoint payload instead of
  // fire-and-forget after(). Orchestrator (wallet-backfill-multicollection)
  // polls this in a sequential loop per wallet until complete=true.
  //
  // Inputs:
  //   ?sync=true                   — enable sync mode
  //   ?max_duration_ms=270000      — caller's wall-clock budget (default 270s,
  //                                  cap 540s; route's maxDuration=600 leaves
  //                                  ~60s for post-pass JOIN + log_pipeline_run).
  //   ?checkpoint=<integer>         — chunk-start offset to resume the paginated
  //                                  recovery path. Ignored on the single-shot
  //                                  happy path (returns complete=true regardless).
  //
  // Response when sync=true:
  //   { ok, complete, next_checkpoint, rows_processed, wallet_address, ... }
  // Default (sync=false / absent): unchanged — 202 fire-and-forget.
  const sync = req.nextUrl.searchParams.get("sync") === "true"
  if (sync) {
    const maxDurationMs = Math.max(
      30_000,
      Math.min(540_000, Number(req.nextUrl.searchParams.get("max_duration_ms") ?? "270000")),
    )
    const checkpointParam = req.nextUrl.searchParams.get("checkpoint")
    const startIndex = checkpointParam && /^\d+$/.test(checkpointParam) ? Number(checkpointParam) : undefined
    const softDeadlineAt = startedMs + maxDurationMs

    const result = await runAllDayDetailsBackfill({
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
    const { rowsFound } = await runAllDayDetailsBackfill({
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
