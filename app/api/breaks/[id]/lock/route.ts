// app/api/breaks/[id]/lock/route.ts
//
// POST — Authorization: Bearer $BREAKS_ADMIN_TOKEN.
//
// Locks a selling break: verifies every spot has been paid, snapshots the
// current sealed Flow block height, picks a target ~10 blocks out for
// RandomBeaconHistory entropy, and flips the row to status=locked. The
// draft route reads draft_seed_target_height once that block is sealed.
//
// For team_draft / random_team formats, also seeds team_pool with the 30
// canonical NBA teams so the deterministic shuffle has a stable list to
// permute. Other formats leave team_pool null.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { CANONICAL_NBA_TEAMS } from "@/lib/breaks/draft-shuffle"
import { getFlowAccessNode } from "@/lib/breaks/server-authz"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const TOKEN = process.env.BREAKS_ADMIN_TOKEN ?? ""
const TARGET_BLOCK_OFFSET = 10
const ETA_SECONDS = 10

type BreakRow = {
  id: string
  status: string
  format: string
}

async function fetchSealedBlockHeight(): Promise<number> {
  const url = `${getFlowAccessNode()}/v1/blocks?height=sealed`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) {
    throw new Error(`flow blocks fetch failed: ${res.status} ${res.statusText}`)
  }
  const body = await res.json()
  const block = Array.isArray(body) ? body[0] : body
  if (!block || !block.header) {
    throw new Error("flow blocks response missing header")
  }
  const heightRaw = block.header.height
  const height = typeof heightRaw === "string" ? parseInt(heightRaw, 10) : Number(heightRaw)
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`flow blocks returned invalid height: ${heightRaw}`)
  }
  return height
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!TOKEN || req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  if (!id) {
    return NextResponse.json({ error: "break id required" }, { status: 400 })
  }

  const startedAt = Date.now()
  console.log(`[breaks/lock] start break_id=${id}`)

  const { data: brk, error: brkErr } = await supabaseAdmin
    .from("breaks")
    .select("id, status, format")
    .eq("id", id)
    .maybeSingle<BreakRow>()
  if (brkErr) {
    return NextResponse.json({ error: brkErr.message }, { status: 500 })
  }
  if (!brk) {
    return NextResponse.json({ error: "break not found" }, { status: 404 })
  }
  if (brk.status !== "selling") {
    return NextResponse.json(
      { error: `break status ${brk.status} is not 'selling'` },
      { status: 409 }
    )
  }

  const { data: spots, error: spotsErr } = await supabaseAdmin
    .from("break_spots")
    .select("spot_index, payment_status")
    .eq("break_id", id)
    .order("spot_index", { ascending: true })
  if (spotsErr) {
    return NextResponse.json({ error: spotsErr.message }, { status: 500 })
  }
  if (!spots || spots.length === 0) {
    return NextResponse.json({ error: "no spots sold" }, { status: 409 })
  }

  const unpaid = spots.filter((s) => s.payment_status !== "captured")
  if (unpaid.length > 0) {
    return NextResponse.json(
      {
        error: "some spots not yet captured",
        pending: unpaid.map((s) => ({ spot_index: s.spot_index, payment_status: s.payment_status })),
      },
      { status: 409 }
    )
  }

  let currentHeight: number
  try {
    currentHeight = await fetchSealedBlockHeight()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[breaks/lock] sealed-height fetch failed: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  const targetHeight = currentHeight + TARGET_BLOCK_OFFSET
  const needsTeamPool = brk.format === "team_draft" || brk.format === "random_team"
  const nowIso = new Date().toISOString()

  const update: Record<string, unknown> = {
    status: "locked",
    locked_at: nowIso,
    draft_seed_block_height: currentHeight,
    draft_seed_target_height: targetHeight,
  }
  if (needsTeamPool) {
    update.team_pool = [...CANONICAL_NBA_TEAMS]
  }

  const { error: updErr } = await supabaseAdmin
    .from("breaks")
    .update(update)
    .eq("id", id)
    .eq("status", "selling")
  if (updErr) {
    console.log(`[breaks/lock] update failed: ${updErr.message}`)
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  console.log(
    `[breaks/lock] locked break_id=${id} current_height=${currentHeight} target=${targetHeight} elapsed_ms=${Date.now() - startedAt}`
  )

  return NextResponse.json({
    ok: true,
    current_height: currentHeight,
    target_height: targetHeight,
    eta_seconds: ETA_SECONDS,
  })
}
