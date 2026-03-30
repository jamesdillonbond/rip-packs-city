import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── Public FMV API ────────────────────────────────────────────────────────────
//
// Exposes RPC's FMV data to authorized third parties (e.g. Flowty).
//
// NOTE: Returns baseFmv (fmv_usd) only — serial and badge adjustments are
// RPC-exclusive and are NOT exposed through this endpoint.
//
// Auth: X-RPC-API-Key header (env: RPC_API_KEY)
//
// GET  /api/fmv?edition={externalId}
//      externalId format: "setUUID:playUUID"
//
// POST /api/fmv
//      body: { editions: string[] }  (max 500)
//
// NOTE: fmv_snapshots.edition_id is a UUID FK to editions.id
// Callers pass externalId ("setUUID:playUUID") = editions.external_id
// We resolve via editions table before querying fmv_snapshots.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BATCH = 500

function isAuthorized(req: NextRequest): boolean {
  const key = req.headers.get("x-rpc-api-key")
  const expected = process.env.RPC_API_KEY
  if (!expected) return false
  return key === expected
}

async function resolveEditionIds(externalIds: string[]): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin
    .from("editions")
    .select("id, external_id")
    .in("external_id", externalIds)
  if (error) throw new Error("editions lookup failed: " + error.message)
  const map = new Map<string, string>()
  for (const row of data ?? []) {
    if (row.external_id && row.id) map.set(row.external_id, row.id)
  }
  return map
}

function formatRow(row: any, externalId: string) {
  return {
    editionId:    externalId,
    collectionId: row.collection_id ?? "topshot",
    fmv:          row.fmv_usd,
    floor:        row.floor_price_usd,
    confidence:   row.confidence,
    salesCount:   row.sales_count_7d,
    algoVersion:  row.algo_version,
    computedAt:   row.computed_at,
  }
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const externalId = req.nextUrl.searchParams.get("edition")
  if (!externalId) {
    return NextResponse.json({ error: "Missing required query param: edition" }, { status: 400 })
  }

  let editionUuid: string | undefined
  try {
    const resolved = await resolveEditionIds([externalId])
    editionUuid = resolved.get(externalId)
  } catch (e) {
    console.error("[FMV API] GET resolve error:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }

  if (!editionUuid) {
    return NextResponse.json(
      { data: [], missing: [externalId], requestedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=60" } }
    )
  }

  const { data: rows, error } = await supabaseAdmin
    .from("fmv_snapshots")
    .select("edition_id, collection_id, fmv_usd, floor_price_usd, confidence, sales_count_7d, algo_version, computed_at")
    .eq("edition_id", editionUuid)
    .order("computed_at", { ascending: false })
    .limit(1)

  if (error) {
    console.error("[FMV API] GET snapshot error:", error.message)
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }

  const data = (rows ?? []).map((r) => formatRow(r, externalId))
  const missing = data.length === 0 ? [externalId] : []

  return NextResponse.json(
    { data, missing, requestedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "public, max-age=120, stale-while-revalidate=60" } }
  )
}

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
    return NextResponse.json({ error: "Body must contain a non-empty editions array" }, { status: 400 })
  }

  const requestedIds: string[] = body.editions
    .filter((id): id is string => typeof id === "string")
    .slice(0, MAX_BATCH)

  if (requestedIds.length === 0) {
    return NextResponse.json({ error: "No valid edition IDs provided" }, { status: 400 })
  }

  let externalToUuid: Map<string, string>
  try {
    externalToUuid = await resolveEditionIds(requestedIds)
  } catch (e) {
    console.error("[FMV API] POST resolve error:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }

  const uuids = [...externalToUuid.values()]
  if (uuids.length === 0) {
    return NextResponse.json(
      { data: [], missing: requestedIds, requestedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "public, max-age=60" } }
    )
  }

  const uuidToExternal = new Map<string, string>()
  for (const [ext, uuid] of externalToUuid.entries()) uuidToExternal.set(uuid, ext)

  const { data: rows, error } = await supabaseAdmin
    .from("fmv_snapshots")
    .select("edition_id, collection_id, fmv_usd, floor_price_usd, confidence, sales_count_7d, algo_version, computed_at")
    .in("edition_id", uuids)
    .order("computed_at", { ascending: false })

  if (error) {
    console.error("[FMV API] POST snapshot error:", error.message)
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }

  const seen = new Set<string>()
  const data: any[] = []
  for (const row of rows ?? []) {
    if (!seen.has(row.edition_id)) {
      seen.add(row.edition_id)
      const externalId = uuidToExternal.get(row.edition_id) ?? row.edition_id
      data.push(formatRow(row, externalId))
    }
  }

  const foundExternal = new Set(data.map((d) => d.editionId))
  const missing = requestedIds.filter((id) => !foundExternal.has(id))

  return NextResponse.json(
    { data, missing, requestedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "public, max-age=120, stale-while-revalidate=60" } }
  )
}