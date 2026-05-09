import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG, publishedCollections } from "@/lib/collections"

// ── wallet_moments_cache FMV populate ────────────────────────────────────────
//
// Multi-collection cron route. For each published collection (or just the one
// passed via ?collection=<slug>), runs populate_wmc_fmv_from_snapshots which
// updates wmc.fmv_usd from the latest fmv_snapshots row per
// (collection_id, edition_key).
//
// Default mode (the cron tick): NULL-only fast path. Only fills rows where
// fmv_usd IS NULL — bounded by the count of newly-inserted moments, not by
// total wmc cardinality. Pass ?force=true for the full sweep that
// re-evaluates every row (heavy on TopShot at 1.17M wmc rows; reserved for
// ad-hoc remediation, not the cron).
//
// Trevor manually backfilled wmc.fmv_usd for the active beta cohort during
// the 2026-05-08 session, but new wallets joining after that hit the gap
// because there was no recurring job. cron-job.org calls this every 20min.
// Pinnacle is included even though fmv_snapshots has zero pinnacle rows
// today — the RPC is a no-op there until pinnacle FMV ingestion ships.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "wmc-fmv-populate"

type CollectionRunResult = {
  slug: string
  collection_id: string
  rows_updated: number
  ok: boolean
  error: string | null
  ms: number
}

async function runOne(
  slug: string,
  collectionUuid: string,
  force: boolean,
  limit: number
): Promise<CollectionRunResult> {
  const startedAtIso = new Date().toISOString()
  const t0 = Date.now()
  let rowsUpdated = 0
  let ok = true
  let errorMessage: string | null = null

  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "populate_wmc_fmv_from_snapshots",
      { p_collection_id: collectionUuid, p_force: force, p_limit: limit }
    )
    if (error) {
      ok = false
      errorMessage = error.message
      console.log(`[wmc-fmv-populate] ${slug} rpc error: ${error.message}`)
    } else {
      rowsUpdated = Number(data ?? 0) || 0
    }
  } catch (e) {
    ok = false
    errorMessage = e instanceof Error ? e.message : String(e)
    console.log(`[wmc-fmv-populate] ${slug} threw: ${errorMessage}`)
  }

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsUpdated,
      p_rows_written: rowsUpdated,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errorMessage,
      p_collection_slug: slug,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        rows_updated: rowsUpdated,
        collection_uuid: collectionUuid,
        force,
        limit,
      },
    })
  } catch (e) {
    console.log(
      `[wmc-fmv-populate] ${slug} log_pipeline_run err: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }

  return {
    slug,
    collection_id: collectionUuid,
    rows_updated: rowsUpdated,
    ok,
    error: errorMessage,
    ms: Date.now() - t0,
  }
}

function authorize(req: NextRequest): boolean {
  if (!TOKEN) return false
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (urlToken === TOKEN) return true
  const auth = req.headers.get("authorization") ?? ""
  if (auth.startsWith("Bearer ") && auth.slice(7) === TOKEN) return true
  return false
}

async function handle(req: NextRequest): Promise<Response> {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const slugParam = req.nextUrl.searchParams.get("collection")?.trim() ?? ""
  const force = req.nextUrl.searchParams.get("force") === "true"
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? "")
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200000
      ? Math.floor(limitRaw)
      : 50000

  let targets: Array<{ slug: string; collection_id: string }> = []
  if (slugParam) {
    const uuid = COLLECTION_UUID_BY_SLUG[slugParam]
    if (!uuid) {
      return NextResponse.json(
        { error: `Unknown collection slug: ${slugParam}` },
        { status: 400 }
      )
    }
    targets = [{ slug: slugParam, collection_id: uuid }]
  } else {
    targets = publishedCollections()
      .filter((c) => !!c.supabaseCollectionId)
      .map((c) => ({ slug: c.id, collection_id: c.supabaseCollectionId! }))
  }

  const results: CollectionRunResult[] = []
  for (const t of targets) {
    results.push(await runOne(t.slug, t.collection_id, force, limit))
  }

  const totalUpdated = results.reduce((sum, r) => sum + r.rows_updated, 0)
  const allOk = results.every((r) => r.ok)

  return NextResponse.json({
    ok: allOk,
    total_updated: totalUpdated,
    force,
    limit,
    results,
  })
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
