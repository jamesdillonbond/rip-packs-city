import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── Phase 1 dual-run wrapper ─────────────────────────────────────────────────
//
// Thin wrapper around `sync_flowty_listings_to_v2(p_collection_id uuid)`. Reads
// rows from the legacy Flowty `cached_listings` table and projects them into
// `cached_listings_v2` with source='flowty', so they can sit beside the
// `source='direct'` rows produced by the per-collection on-chain listings
// indexer (see `app/api/allday-listings-indexer/route.ts`). The two sources
// drive the divergence snapshot in `app/api/listing-divergence-snapshot`.
//
// Single statement — RPC completes in well under a second, so this route runs
// synchronously without `after()`. Auth + pipeline_runs logging mirror the
// other indexer routes.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "sync-flowty-listings"

const COLLECTION_UUID_BY_DB_SLUG: Record<string, string> = {
  nba_top_shot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  nfl_all_day: "dee28451-5d62-409e-a1ad-a83f763ac070",
  laliga_golazos: "06248cc4-b85f-47cd-af67-1855d14acd75",
  ufc_strike: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  disney_pinnacle: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function POST(req: NextRequest) {
  const start = Date.now()
  const startedAt = new Date().toISOString()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const slug = req.nextUrl.searchParams.get("collection") ?? ""
  if (!slug) {
    return NextResponse.json(
      { ok: false, error: "missing required ?collection= query param" },
      { status: 400 }
    )
  }
  const collectionId = COLLECTION_UUID_BY_DB_SLUG[slug]
  if (!collectionId) {
    return NextResponse.json(
      {
        ok: false,
        error: `unrecognized collection slug "${slug}". Valid: ${Object.keys(COLLECTION_UUID_BY_DB_SLUG).join(", ")}`,
      },
      { status: 400 }
    )
  }

  let rowsUpserted = 0
  let rowsSoftCompleted = 0
  let rowsResolvedToEdition = 0
  let ok = true
  let errorMsg: string | null = null

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("sync_flowty_listings_to_v2", {
      p_collection_id: collectionId,
    })
    if (error) throw new Error(error.message)
    const row = Array.isArray(data) ? data[0] : data
    rowsUpserted = Number(row?.rows_upserted ?? 0)
    rowsSoftCompleted = Number(row?.rows_soft_completed ?? 0)
    rowsResolvedToEdition = Number(row?.rows_resolved_to_edition ?? 0)
  } catch (err) {
    ok = false
    errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[sync-flowty-listings] rpc err:`, errorMsg)
  }

  const elapsedMs = Date.now() - start

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: rowsUpserted,
      p_rows_written: rowsUpserted,
      p_rows_skipped: rowsSoftCompleted,
      p_ok: ok,
      p_error: errorMsg,
      p_collection_slug: slug,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        rows_upserted: rowsUpserted,
        rows_soft_completed: rowsSoftCompleted,
        rows_resolved_to_edition: rowsResolvedToEdition,
        elapsed_ms: elapsedMs,
      },
    })
  } catch (e) {
    console.log(
      `[sync-flowty-listings] log_pipeline_run err:`,
      e instanceof Error ? e.message : String(e)
    )
  }

  if (!ok) {
    return NextResponse.json({ ok: false, error: errorMsg }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    rows_upserted: rowsUpserted,
    rows_soft_completed: rowsSoftCompleted,
    rows_resolved_to_edition: rowsResolvedToEdition,
    elapsed_ms: elapsedMs,
  })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
