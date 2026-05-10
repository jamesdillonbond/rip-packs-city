// app/api/breaks/[id]/draft/route.ts
//
// POST — Authorization: Bearer $BREAKS_ADMIN_TOKEN.
//
// Reads RandomBeaconHistory.sourceOfRandomness at the locked break's
// draft_seed_target_height, then assigns NBA teams to spots via the
// deterministicShuffle helper. Idempotent — once draft_seed_source +
// draft_assignment are populated, subsequent calls return the existing
// assignment. Returns 425 (Too Early) if the target block isn't sealed
// yet so the admin UI can poll.
//
// Personal / razz / division formats short-circuit because they don't
// need a team draft.

import { NextRequest, NextResponse } from "next/server"
import * as fcl from "@onflow/fcl"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"
import { configureFcl, getFlowAccessNode } from "@/lib/breaks/server-authz"
import { BREAK_RANDOM_SOURCE } from "@/lib/cadence/break-transactions"
import { assignTeamsToSpots } from "@/lib/breaks/draft-shuffle"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const TOKEN = process.env.BREAKS_ADMIN_TOKEN ?? ""
const SECONDS_PER_BLOCK = 1

type BreakRow = {
  id: string
  status: string
  format: string
  draft_seed_target_height: number | null
  draft_seed_source: string | null
  team_pool: string[] | null
  draft_assignment: Record<string, string> | null
}

async function fetchSealedBlockHeight(): Promise<number> {
  const url = `${getFlowAccessNode()}/v1/blocks?height=sealed`
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) {
    throw new Error(`flow blocks fetch failed: ${res.status} ${res.statusText}`)
  }
  const body = await res.json()
  const block = Array.isArray(body) ? body[0] : body
  if (!block?.header) throw new Error("flow blocks response missing header")
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
  console.log(`[breaks/draft] start break_id=${id}`)

  const { data: brk, error: brkErr } = await supabaseAdmin
    .from("breaks")
    .select("id, status, format, draft_seed_target_height, draft_seed_source, team_pool, draft_assignment")
    .eq("id", id)
    .maybeSingle<BreakRow>()
  if (brkErr) {
    return NextResponse.json({ error: brkErr.message }, { status: 500 })
  }
  if (!brk) {
    return NextResponse.json({ error: "break not found" }, { status: 404 })
  }
  if (brk.status !== "locked") {
    return NextResponse.json(
      { error: `break status ${brk.status} is not 'locked'` },
      { status: 409 }
    )
  }

  if (brk.format !== "team_draft" && brk.format !== "random_team") {
    console.log(`[breaks/draft] format=${brk.format} no draft needed`)
    return NextResponse.json({ ok: true, no_draft_needed: true, format: brk.format })
  }

  if (brk.draft_seed_source && brk.draft_assignment) {
    console.log(`[breaks/draft] idempotent return — draft already complete`)
    return NextResponse.json({
      ok: true,
      idempotent: true,
      seed_source_hex: brk.draft_seed_source,
      assignment: brk.draft_assignment,
      target_height: brk.draft_seed_target_height,
    })
  }

  if (!brk.draft_seed_target_height) {
    return NextResponse.json({ error: "draft_seed_target_height missing" }, { status: 500 })
  }
  if (!brk.team_pool || brk.team_pool.length === 0) {
    return NextResponse.json({ error: "team_pool missing for draft format" }, { status: 500 })
  }

  let currentHeight: number
  try {
    currentHeight = await fetchSealedBlockHeight()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[breaks/draft] sealed-height fetch failed: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  if (currentHeight < brk.draft_seed_target_height) {
    const remaining = brk.draft_seed_target_height - currentHeight
    return NextResponse.json(
      {
        ok: false,
        not_yet: true,
        current_height: currentHeight,
        target_height: brk.draft_seed_target_height,
        seconds_remaining: remaining * SECONDS_PER_BLOCK,
      },
      { status: 425 }
    )
  }

  configureFcl()
  let entropyBytes: number[]
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (fcl.query as any)({
      cadence: BREAK_RANDOM_SOURCE,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any) => [arg(String(brk.draft_seed_target_height), t.UInt64)],
    })
    entropyBytes = (raw as Array<number | string>).map((v) =>
      typeof v === "string" ? parseInt(v, 10) : v
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[breaks/draft] random-source query failed: ${msg}`)
    return NextResponse.json({ error: `flow query failed: ${msg}` }, { status: 502 })
  }

  if (!Array.isArray(entropyBytes) || entropyBytes.length === 0) {
    return NextResponse.json({ error: "empty random source" }, { status: 502 })
  }

  const seed = Buffer.from(entropyBytes)
  const seedHex = seed.toString("hex")

  const { data: spots, error: spotsErr } = await supabaseAdmin
    .from("break_spots")
    .select("id, spot_index")
    .eq("break_id", id)
    .order("spot_index", { ascending: true })
  if (spotsErr) {
    return NextResponse.json({ error: spotsErr.message }, { status: 500 })
  }
  if (!spots || spots.length === 0) {
    return NextResponse.json({ error: "no spots to draft" }, { status: 409 })
  }

  let teams: string[]
  try {
    teams = assignTeamsToSpots(brk.team_pool, spots.length, seed)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  const assignment: Record<string, string> = {}
  const nowIso = new Date().toISOString()

  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i]
    const team = teams[i]
    assignment[String(spot.spot_index)] = team
    const { error: updErr } = await supabaseAdmin
      .from("break_spots")
      .update({ team_assignment: team })
      .eq("id", spot.id)
    if (updErr) {
      console.log(`[breaks/draft] spot ${spot.id} team update failed: ${updErr.message}`)
    }
  }

  const { error: brkUpdErr } = await supabaseAdmin
    .from("breaks")
    .update({
      draft_seed_source: seedHex,
      draft_assignment: assignment,
      drafted_at: nowIso,
    })
    .eq("id", id)
  if (brkUpdErr) {
    console.log(`[breaks/draft] break update failed: ${brkUpdErr.message}`)
    return NextResponse.json({ error: brkUpdErr.message }, { status: 500 })
  }

  console.log(
    `[breaks/draft] drafted break_id=${id} spots=${spots.length} target=${brk.draft_seed_target_height} elapsed_ms=${Date.now() - startedAt}`
  )

  return NextResponse.json({
    ok: true,
    seed_source_hex: seedHex,
    assignment,
    target_height: brk.draft_seed_target_height,
  })
}
