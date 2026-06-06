import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG, publishedCollections } from "@/lib/collections"

// ── wallet_moments_cache FMV + image populate ────────────────────────────────
//
// Multi-collection cron route. For each published collection (or just the one
// passed via ?collection=<slug>), runs two denorm RPCs:
//   1. populate_wmc_fmv_from_snapshots — updates wmc.fmv_usd from the latest
//      fmv_snapshots row per (collection_id, edition_key).
//   2. populate_wmc_image — denormalizes editions.thumbnail_url (TS/AllDay/
//      Golazos/UFC) and pinnacle_editions.thumbnail_url (Pinnacle, http-only)
//      into wmc.image_url so /share + get_wallet_collection_snapshot render
//      real tiles. NULL-only here; image_url was never populated before, so
//      there's a large one-time backlog draining at IMAGE_LIMIT/collection/tick
//      (backed by the partial index idx_wmc_image_url_null).
// An image failure is isolated — it's recorded in pipeline_runs.extra and does
// not flip the FMV path's ok flag.
//
// On full (all-collections) ticks it also runs refresh_wmc_fmv_changed once —
// a global, timeout-proof FMV-drift refresh that re-evaluates wmc.fmv_usd for
// editions whose snapshot moved recently (the NULL-only paths above never
// re-eval an already-set fmv). Skipped on ?collection= calls and ?skip_refresh.
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

// populate_wmc_image NULL-only chunk. 50k is the verified-safe ceiling — larger
// limits time out on the unindexed-tail join (idx_wmc_image_url_null covers the
// NULL scan). force mode is reserved for ad-hoc remediation, not the cron.
const IMAGE_LIMIT = 50000

// Window for the FMV-drift refresh. The cron fires ~every 20min; 30 absorbs a
// missed tick without over-scanning. refresh_wmc_fmv_changed is budget-bounded
// internally so a wider window just means more grind, never a timeout.
const REFRESH_SINCE_MINUTES = 30

type CollectionRunResult = {
  slug: string
  collection_id: string
  rows_updated: number
  rows_imaged: number
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
  let rowsImaged = 0
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
      console.log(`[wmc-fmv-populate] ${slug} fmv rpc error: ${error.message}`)
    } else {
      rowsUpdated = Number(data ?? 0) || 0
    }
  } catch (e) {
    ok = false
    errorMessage = e instanceof Error ? e.message : String(e)
    console.log(`[wmc-fmv-populate] ${slug} fmv threw: ${errorMessage}`)
  }

  // Denormalize edition art into wmc.image_url so /share + the collection
  // snapshot render real tiles, not placeholders. NULL-only by default; the
  // backlog (~1.4M rows at wire-up) drains ~IMAGE_LIMIT/collection/tick.
  // Failures here don't fail the FMV path — they're logged into extra.
  let imageError: string | null = null
  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "populate_wmc_image",
      { p_collection_id: collectionUuid, p_force: force, p_limit: IMAGE_LIMIT }
    )
    if (error) {
      imageError = error.message
      console.log(`[wmc-fmv-populate] ${slug} image rpc error: ${error.message}`)
    } else {
      rowsImaged = Number(data ?? 0) || 0
    }
  } catch (e) {
    imageError = e instanceof Error ? e.message : String(e)
    console.log(`[wmc-fmv-populate] ${slug} image threw: ${imageError}`)
  }

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsUpdated + rowsImaged,
      p_rows_written: rowsUpdated + rowsImaged,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errorMessage,
      p_collection_slug: slug,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        rows_updated: rowsUpdated,
        rows_imaged: rowsImaged,
        image_error: imageError,
        collection_uuid: collectionUuid,
        force,
        limit,
        image_limit: IMAGE_LIMIT,
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
    rows_imaged: rowsImaged,
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

  const skipRefresh = req.nextUrl.searchParams.get("skip_refresh") === "true"

  // CRON-30S: the per-collection FMV+image populate + the FMV-drift refresh take
  // >30s to finish — longer than cron-job.org's hard client cap, so every tick
  // was marked "Failed (timeout)" even though the work lands fine server-side
  // (and a persistently-failing job risks cron-job.org auto-disabling it, which
  // would silently kill the image + FMV-drift pipelines). Per the CLAUDE.md
  // fire-and-forget convention, do the heavy work in after() and return 202 now.
  // The real success signal is the per-collection log_pipeline_run inside runOne
  // (unchanged); the fatal-catch below surfaces a crashed background pass.
  after(async () => {
    try {
      for (const t of targets) {
        await runOne(t.slug, t.collection_id, force, limit)
      }

      // Targeted FMV-drift refresh: re-evaluate wmc.fmv_usd for editions whose
      // snapshot moved in the last REFRESH_SINCE_MINUTES. The per-collection loop
      // above is NULL-only (never re-evals an already-set fmv), so without this a
      // changed snapshot never propagates to wmc. refresh_wmc_fmv_changed is
      // global + timeout-proof (chunked internal loop). Runs once per full tick;
      // skipped on single-collection calls and ?skip_refresh=true.
      if (!slugParam && !skipRefresh) {
        try {
          const { error } = await (supabaseAdmin as any).rpc(
            "refresh_wmc_fmv_changed",
            { p_since_minutes: REFRESH_SINCE_MINUTES, p_limit: 50000 }
          )
          if (error) console.log(`[wmc-fmv-populate] refresh rpc error: ${error.message}`)
        } catch (e) {
          console.log(`[wmc-fmv-populate] refresh threw: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      // pipeline_runs-as-crash-logger: a background crash before/around runOne
      // (which logs its own per-collection rows) still surfaces here.
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: PIPELINE_NAME,
          p_started_at: new Date().toISOString(),
          p_rows_found: 0,
          p_rows_written: 0,
          p_rows_skipped: 0,
          p_ok: false,
          p_error: `background pass crashed: ${e instanceof Error ? e.message : String(e)}`,
          p_collection_slug: null,
          p_cursor_before: null,
          p_cursor_after: null,
          p_extra: { fatal: true },
        })
      } catch {
        // best-effort
      }
    }
  })

  return NextResponse.json(
    {
      accepted: true,
      targets: targets.map((t) => t.slug),
      force,
      limit,
      refresh: !slugParam && !skipRefresh,
    },
    { status: 202 }
  )
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
