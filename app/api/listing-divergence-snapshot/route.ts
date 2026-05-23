import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Phase 1 dual-run wrapper.
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
//
// Flowty-offline guard (2026-05-23 health audit):
// Flowty shut down its NFT marketplace (~2026-05-13). `cached_listings_v2`
// now holds only a handful of stale `source='flowty'` rows (e.g. 8 open for
// nfl_all_day vs 34k+ direct), so the divergence comparison is meaningless.
// Worse, `compute_listing_divergence` still scans the full ~34k-row direct
// universe and was timing out on ~80% of runs ("canceling statement due to
// statement timeout" / "Timed out acquiring connection from connection pool"),
// burning 75-135s of DB time per failure and worsening pool contention for
// every other pipeline. The guard below short-circuits with ok=true when the
// open Flowty listing count is below FLOWTY_OFFLINE_THRESHOLD. It is
// self-healing: if Flowty's feed ever revives and the count climbs back over
// the threshold, the full comparison resumes automatically with no code change.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "listing-divergence-snapshot"

// Below this many *open* Flowty listings the marketplace is treated as offline
// and the expensive divergence scan is skipped. When Flowty was live a single
// collection carried hundreds-to-thousands of open listings, so 50 cleanly
// separates "offline" (single-digit stale rows) from "alive".
const FLOWTY_OFFLINE_THRESHOLD = 50

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
  let skipped = false

  // Flowty-offline guard: cheap count of open Flowty listings before committing
  // to the heavy RPC. If the count errors we deliberately fall through to the
  // normal path rather than skipping blind.
  try {
    const { count: flowtyOpen, error: countErr } = await (supabaseAdmin as any)
      .from("cached_listings_v2")
      .select("listing_resource_id", { count: "exact", head: true })
      .eq("collection_id", collectionId)
      .eq("source", "flowty")
      .is("completed_at", null)

    if (!countErr && typeof flowtyOpen === "number" && flowtyOpen < FLOWTY_OFFLINE_THRESHOLD) {
      skipped = true
      totalFlowty = flowtyOpen
      console.log(`[listing-divergence-snapshot] skip ${slug}: ${flowtyOpen} open Flowty listings below threshold ${FLOWTY_OFFLINE_THRESHOLD} - Flowty marketplace offline, divergence scan not run`)
    }
  } catch (e) {
    console.log(`[listing-divergence-snapshot] flowty pre-check err (proceeding):`, e instanceof Error ? e.message : String(e))
  }

  if (!skipped) {
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
  }

  const elapsedMs = Date.now() - start

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: totalFlowty + totalDirect,
      p_rows_written: skipped ? 0 : 1,
      p_rows_skipped: skipped ? 1 : 0,
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
        skipped,
        skip_reason: skipped ? "flowty_offline" : null,
      },
    })
  } catch (e) {
    console.log(`[listing-divergence-snapshot] log_pipeline_run err:`, e instanceof Error ? e.message : String(e))
  }

  if (!ok) {
    return NextResponse.json({ ok: false, error: errorMsg }, { status: 500 })
  }

  if (skipped) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      skip_reason: "flowty_offline",
      total_flowty: totalFlowty,
      elapsed_ms: elapsedMs,
    })
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
