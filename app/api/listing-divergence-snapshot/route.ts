import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── Phase 1 dual-run wrapper ─────────────────────────────────────────────────
//
// Thin wrapper around `compute_listing_divergence(p_collection_id, p_write_snapshot, p_notes)`.
// Compares `cached_listings_v2.source='flowty'` vs `source='direct'` for the
// given collection and (when p_write_snapshot=true) writes a snapshot row so
// divergence trends are queryable over time. Pairs with `sync-flowty-listings`
// to give us a measurable signal on whether Flowty's listing feed and our
// direct on-chain indexer agree on the same listing universe.
//
// Single statement, runs synchronously. Auth + pipeline_runs logging mirror
// the other indexer routes.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "listing-divergence-snapshot"

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
  const notes = req.nextUrl.searchParams.get("notes")

  let totalFlowty = 0
  let totalDirect = 0
  let matched = 0
  let flowtyOnly = 0
  let directOnly = 0
  let priceMismatches = 0
  let divergencePct: number | null = null
  let ok = true
  let errorMsg: string | null = null

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("compute_listing_divergence", {
      p_collection_id: collectionId,
      p_write_snapshot: true,
      p_notes: notes,
    })
    if (error) throw new Error(error.message)
    const row = Array.isArray(data) ? data[0] : data
    totalFlowty = Number(row?.total_flowty ?? 0)
    totalDirect = Number(row?.total_direct ?? 0)
    matched = Number(row?.matched ?? 0)
    flowtyOnly = Number(row?.flowty_only ?? 0)
    directOnly = Number(row?.direct_only ?? 0)
    priceMismatches = Number(row?.price_mismatches ?? 0)
    divergencePct = row?.divergence_pct !== null && row?.divergence_pct !== undefined
      ? Number(row.divergence_pct)
      : null
  } catch (err) {
    ok = false
    errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[listing-divergence-snapshot] rpc err:`, errorMsg)
  }

  const elapsedMs = Date.now() - start

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: totalFlowty + totalDirect,
      p_rows_written: 1,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errorMsg,
      p_collection_slug: slug,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        total_flowty: totalFlowty,
        total_direct: totalDirect,
        matched,
        flowty_only: flowtyOnly,
        direct_only: directOnly,
        price_mismatches: priceMismatches,
        divergence_pct: divergencePct,
        elapsed_ms: elapsedMs,
      },
    })
  } catch (e) {
    console.log(
      `[listing-divergence-snapshot] log_pipeline_run err:`,
      e instanceof Error ? e.message : String(e)
    )
  }

  if (!ok) {
    return NextResponse.json({ ok: false, error: errorMsg }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    total_flowty: totalFlowty,
    total_direct: totalDirect,
    matched,
    flowty_only: flowtyOnly,
    direct_only: directOnly,
    price_mismatches: priceMismatches,
    divergence_pct: divergencePct,
    elapsed_ms: elapsedMs,
  })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
