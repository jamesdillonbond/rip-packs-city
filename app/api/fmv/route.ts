import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── Public FMV API ────────────────────────────────────────────────────────────
//
// Exposes RPC's FMV data to authorized third parties (e.g. Flowty).
//
// NOTE: Returns baseFmv (fmv_usd) only — serial and badge adjustments are
// RPC-exclusive and are NOT exposed through this endpoint. That intelligence
// stays proprietary to the RPC platform.
//
// Auth: X-RPC-API-Key header (env: RPC_API_KEY)
// Rate: enforced at the infra level — implement per-key limits when Flowty
//       integration is live.
//
// GET  /api/fmv?edition={uuid}
//      → single edition lookup
//
// POST /api/fmv
//      body: { editions: string[] }  (max 500 per request)
//      → batch lookup for multiple editions
//
// Response shape (both modes):
// {
//   data: Array<{
//     editionId:    string   // Top Shot edition UUID
//     collectionId: string   // e.g. "topshot", "allday"
//     fmv:          number   // USD, trimmed median from 30-day sales history
//     floor:        number   // lowest sale price in 30-day window
//     confidence:   "HIGH" | "MEDIUM" | "LOW"
//     salesCount:   number   // sales in 30-day window
//     algoVersion:  string   // e.g. "1.2.0"
//     computedAt:   string   // ISO timestamp of last recalc
//   }>
//   missing: string[]        // edition UUIDs with no data
//   requestedAt: string      // ISO timestamp of this response
// }
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BATCH = 500

function isAuthorized(req: NextRequest): boolean {
  const key = req.headers.get("x-rpc-api-key")
  const expected = process.env.RPC_API_KEY
  if (!expected) return false
  return key === expected
}

function buildResponse(
  rows: any[],
  requestedIds: string[]
) {
  const found = new Set<string>()

  const data = rows.map((row) => {
    found.add(row.edition_id)
    return {
      editionId:    row.edition_id,
      collectionId: row.collection_id ?? "topshot",
      fmv:          row.fmv_usd,
      floor:        row.floor_price_usd,
      confidence:   row.confidence,
      salesCount:   row.sales_count_7d,
      algoVersion:  row.algo_version,
      computedAt:   row.computed_at,
    }
  })

  const missing = requestedIds.filter((id) => !found.has(id))

  return { data, missing, requestedAt: new Date().toISOString() }
}

// ── GET: single edition ───────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const editionId = req.nextUrl.searchParams.get("edition")
  if (!editionId) {
    return NextResponse.json(
      { error: "Missing required query param: edition" },
      { status: 400 }
    )
  }

  const { data: rows, error } = await supabaseAdmin
    .from("fmv_snapshots")
    .select("edition_id, collection_id, fmv_usd, floor_price_usd, confidence, sales_count_7d, algo_version, computed_at")
    .eq("edition_id", editionId)
    .order("computed_at", { ascending: false })
    .limit(1)

  if (error) {
    console.error("[FMV API] GET error:", error.message)
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }

  const result = buildResponse(rows ?? [], [editionId])

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, max-age=120, stale-while-revalidate=60" },
  })
}

// ── POST: batch editions ──────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { editions?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!Array.isArray(body.editions) || body.editions.length === 0) {
    return NextResponse.json(
      { error: "Body must contain a non-empty editions array" },
      { status: 400 }
    )
  }

  const requestedIds: string[] = body.editions
    .filter((id): id is string => typeof id === "string")
    .slice(0, MAX_BATCH)

  if (requestedIds.length === 0) {
    return NextResponse.json(
      { error: "No valid edition UUIDs provided" },
      { status: 400 }
    )
  }

  // For each edition, get the most recent snapshot only.
  // fmv_snapshots is partitioned by computed_at so we can't do a simple
  // DISTINCT ON via the JS client — fetch all matching rows and deduplicate
  // by keeping the latest computed_at per edition_id.
  const { data: rows, error } = await supabaseAdmin
    .from("fmv_snapshots")
    .select("edition_id, collection_id, fmv_usd, floor_price_usd, confidence, sales_count_7d, algo_version, computed_at")
    .in("edition_id", requestedIds)
    .order("computed_at", { ascending: false })

  if (error) {
    console.error("[FMV API] POST batch error:", error.message)
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }

  // Deduplicate — keep latest snapshot per edition
  const latestByEdition = new Map<string, any>()
  for (const row of rows ?? []) {
    if (!latestByEdition.has(row.edition_id)) {
      latestByEdition.set(row.edition_id, row)
    }
  }

  const result = buildResponse([...latestByEdition.values()], requestedIds)

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, max-age=120, stale-while-revalidate=60" },
  })
}