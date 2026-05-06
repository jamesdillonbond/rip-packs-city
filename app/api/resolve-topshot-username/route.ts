// /api/resolve-topshot-username — username → wallet resolver.
//
// Layers (in order):
//   1-4. Postgres `resolve_topshot_username` RPC (wallet_usernames →
//        seeded_wallets → saved_wallets → user_profiles)
//   5.   Live Top Shot GraphQL via topshot-proxy
//
// Hits at layer 5 are written back via `cache_topshot_username` so future
// resolutions short-circuit at layer 1. Cache hits do NOT log to
// pipeline_runs (high-cardinality lookups would drown the table); only
// outbound GQL calls + their outcomes are recorded.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveTopShotUsernameCacheAware } from "@/lib/topshot-username-resolve"

export const dynamic = "force-dynamic"

async function logRun(args: {
  startedAt: string
  username: string
  ok: boolean
  reason?: string | null
  walletAddress?: string | null
  cacheLayer?: string | null
  elapsedMs: number
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "resolve-topshot-username",
      p_started_at: args.startedAt,
      p_rows_found: args.ok ? 1 : 0,
      p_rows_written: args.ok ? 1 : 0,
      p_rows_skipped: 0,
      p_ok: args.ok,
      p_error: args.reason ?? null,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        username: args.username,
        wallet_address: args.walletAddress ?? null,
        cache_layer: args.cacheLayer ?? null,
        elapsed_ms: args.elapsedMs,
      },
    })
  } catch (err) {
    console.warn(
      `[resolve-topshot-username] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? ""
  const expected = process.env.INGEST_SECRET_TOKEN
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let body: { username?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 })
  }

  const username = body.username?.trim()
  if (!username) {
    return NextResponse.json(
      { found: false, reason: "username_required" },
      { status: 400 }
    )
  }

  const startedMs = Date.now()
  const startedAtIso = new Date(startedMs).toISOString()

  const outcome = await resolveTopShotUsernameCacheAware(supabaseAdmin, username)

  if (outcome.found) {
    // Only log when the resolution required an outbound GQL call. Cached
    // layers (1-4) skip pipeline_runs to keep the table low-cardinality.
    if (outcome.cacheLayer === "topshot_gql_live") {
      await logRun({
        startedAt: startedAtIso,
        username,
        ok: true,
        walletAddress: outcome.walletAddress,
        cacheLayer: outcome.cacheLayer,
        elapsedMs: Date.now() - startedMs,
      })
    }
    return NextResponse.json({
      found: true,
      wallet_address: outcome.walletAddress,
      username: outcome.username,
      source: outcome.source,
      cache_layer: outcome.cacheLayer,
      ...(outcome.dapperId != null ? { dapper_id: outcome.dapperId } : {}),
    })
  }

  // Misses get logged so we can audit upstream stability + the unresolved
  // username pool over time. `empty_username` is a 400 caller bug; skip it.
  if (outcome.reason !== "empty_username") {
    await logRun({
      startedAt: startedAtIso,
      username,
      ok: false,
      reason: outcome.reason,
      elapsedMs: Date.now() - startedMs,
    })
  }

  return NextResponse.json(
    {
      found: false,
      reason: outcome.reason,
      ...(("detail" in outcome ? outcome.detail : null) != null
        ? { detail: (outcome as { detail: string }).detail }
        : {}),
    },
    { status: outcome.reason === "empty_username" ? 400 : 200 }
  )
}
