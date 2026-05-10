// app/api/breaks/[id]/validate-recipients/route.ts
//
// POST — Authorization: Bearer $BREAKS_ADMIN_TOKEN.
//
// Walks every break_spots row for the given break and asks Flow whether
// the buyer wallet has a public TopShot collection capability. Updates
// capability_validated / capability_validated_at on each spot. Returns a
// summary so the admin UI can show which buyers still need to set their
// wallet up before lock.
//
// Allowed when status IN (selling, locked) — anything earlier means the
// spots aren't sold yet, anything later means the draft has begun and
// validation is moot.

import { NextRequest, NextResponse } from "next/server"
import * as fcl from "@onflow/fcl"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"
import { configureFcl } from "@/lib/breaks/server-authz"
import { BREAK_VALIDATE_RECIPIENTS_TS } from "@/lib/cadence/break-transactions"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const TOKEN = process.env.BREAKS_ADMIN_TOKEN ?? ""

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
  console.log(`[breaks/validate-recipients] start break_id=${id}`)

  const { data: brk, error: brkErr } = await supabaseAdmin
    .from("breaks")
    .select("id, status")
    .eq("id", id)
    .maybeSingle()
  if (brkErr) {
    console.log(`[breaks/validate-recipients] break load error: ${brkErr.message}`)
    return NextResponse.json({ error: brkErr.message }, { status: 500 })
  }
  if (!brk) {
    return NextResponse.json({ error: "break not found" }, { status: 404 })
  }
  if (!["selling", "locked"].includes(brk.status)) {
    return NextResponse.json(
      { error: `break status ${brk.status} not in (selling, locked)` },
      { status: 409 }
    )
  }

  const { data: spots, error: spotsErr } = await supabaseAdmin
    .from("break_spots")
    .select("id, spot_index, customer_email, customer_wallet")
    .eq("break_id", id)
    .order("spot_index", { ascending: true })
  if (spotsErr) {
    console.log(`[breaks/validate-recipients] spots load error: ${spotsErr.message}`)
    return NextResponse.json({ error: spotsErr.message }, { status: 500 })
  }
  if (!spots || spots.length === 0) {
    return NextResponse.json({ validated: 0, failures: [] })
  }

  const addrs = spots.map((s) => s.customer_wallet)
  configureFcl()

  let result: boolean[]
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (fcl.query as any)({
      cadence: BREAK_VALIDATE_RECIPIENTS_TS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any) => [arg(addrs, t.Array(t.Address))],
    })
    result = (raw as boolean[]) || []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[breaks/validate-recipients] fcl.query failed: ${msg}`)
    return NextResponse.json({ error: `flow query failed: ${msg}` }, { status: 502 })
  }

  if (result.length !== spots.length) {
    console.log(
      `[breaks/validate-recipients] length mismatch script=${result.length} spots=${spots.length}`
    )
    return NextResponse.json(
      { error: "flow result length did not match spots" },
      { status: 502 }
    )
  }

  const nowIso = new Date().toISOString()
  const failures: Array<{ spot_index: number; wallet: string; email: string }> = []

  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i]
    const ok = !!result[i]
    const { error: updErr } = await supabaseAdmin
      .from("break_spots")
      .update({
        capability_validated: ok,
        capability_validated_at: nowIso,
      })
      .eq("id", spot.id)
    if (updErr) {
      console.log(
        `[breaks/validate-recipients] update spot ${spot.id} failed: ${updErr.message}`
      )
    }
    if (!ok) {
      failures.push({
        spot_index: spot.spot_index,
        wallet: spot.customer_wallet,
        email: spot.customer_email,
      })
    }
  }

  console.log(
    `[breaks/validate-recipients] done break_id=${id} validated=${spots.length} failures=${failures.length} elapsed_ms=${Date.now() - startedAt}`
  )

  return NextResponse.json({ validated: spots.length, failures })
}
