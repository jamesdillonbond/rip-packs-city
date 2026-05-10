// app/api/breaks/[id]/distribute/route.ts
//
// POST — Authorization: Bearer $BREAKS_ADMIN_TOKEN.
//
// Fans pending break_results out across the buyer wallets in chunks of
// CHUNK_SIZE recipients/moments per Flow transaction (sized so the
// BREAK_MULTI_TRANSFER_TS withdraw+deposit loop fits inside a single
// transaction's compute budget). For each chunk:
//   1. Insert a break_distributions row (pending).
//   2. fcl.mutate the multi-transfer signed by the hot wallet.
//   3. Wait for seal (with 60s timeout). On seal mark the row sealed and
//      flip every result's transfer_status to transferred. On failure
//      mark the row failed; the results stay pending so a re-POST will
//      retry just the failed/pending chunks.
//
// Idempotency: results that are already transferred are skipped on
// re-POST. Failed chunks are retried by re-running the route.
//
// Pre-state: assumes status=ripping and break_results rows have already
// been seeded with moment_id + spot_id by the rip-tracker (out of scope
// for v0). Final state flips to complete when every result is
// transferred, or distributing if any are still pending/failed.

import { NextRequest, NextResponse } from "next/server"
import * as fcl from "@onflow/fcl"
import * as t from "@onflow/types"
import { supabaseAdmin } from "@/lib/supabase"
import { configureFcl, buildHotWalletAuthz } from "@/lib/breaks/server-authz"
import { BREAK_MULTI_TRANSFER_TS } from "@/lib/cadence/break-transactions"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 600

const TOKEN = process.env.BREAKS_ADMIN_TOKEN ?? ""
const CHUNK_SIZE = 30
const SEAL_TIMEOUT_MS = 60_000

type ResultRow = {
  id: string
  break_id: string
  spot_id: string
  moment_id: string
  transfer_status: string
  spot_index: number
  customer_wallet: string
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(to)
        resolve(v)
      },
      (e) => {
        clearTimeout(to)
        reject(e)
      }
    )
  })
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
  console.log(`[breaks/distribute] start break_id=${id}`)

  const { data: brk, error: brkErr } = await supabaseAdmin
    .from("breaks")
    .select("id, status")
    .eq("id", id)
    .maybeSingle()
  if (brkErr) {
    return NextResponse.json({ error: brkErr.message }, { status: 500 })
  }
  if (!brk) {
    return NextResponse.json({ error: "break not found" }, { status: 404 })
  }
  if (brk.status !== "ripping" && brk.status !== "distributing") {
    return NextResponse.json(
      { error: `break status ${brk.status} is not 'ripping' or 'distributing'` },
      { status: 409 }
    )
  }

  const { data: pendingRaw, error: resErr } = await supabaseAdmin
    .from("break_results")
    .select("id, break_id, spot_id, moment_id, transfer_status, break_spots!inner(spot_index, customer_wallet)")
    .eq("break_id", id)
    .eq("transfer_status", "pending")
  if (resErr) {
    return NextResponse.json({ error: resErr.message }, { status: 500 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending: ResultRow[] = ((pendingRaw as any[]) || []).map((r: any) => ({
    id: r.id,
    break_id: r.break_id,
    spot_id: r.spot_id,
    moment_id: r.moment_id,
    transfer_status: r.transfer_status,
    spot_index: r.break_spots?.spot_index ?? 0,
    customer_wallet: r.break_spots?.customer_wallet ?? "",
  }))

  if (pending.length === 0) {
    console.log(`[breaks/distribute] no pending results break_id=${id}`)
    await maybeMarkComplete(id)
    return NextResponse.json({
      ok: true,
      chunks_total: 0,
      sealed: 0,
      failed: 0,
      pending: 0,
      results_transferred: 0,
    })
  }

  pending.sort((a, b) => {
    if (a.spot_index !== b.spot_index) return a.spot_index - b.spot_index
    return a.id.localeCompare(b.id)
  })

  const { data: existingChunks, error: chunkErr } = await supabaseAdmin
    .from("break_distributions")
    .select("chunk_index")
    .eq("break_id", id)
    .order("chunk_index", { ascending: false })
    .limit(1)
  if (chunkErr) {
    return NextResponse.json({ error: chunkErr.message }, { status: 500 })
  }
  let nextChunkIndex = (existingChunks && existingChunks[0]?.chunk_index != null)
    ? Number(existingChunks[0].chunk_index) + 1
    : 0

  configureFcl()
  const authz = buildHotWalletAuthz()

  let sealedCount = 0
  let failedCount = 0
  let resultsTransferred = 0

  const chunks: ResultRow[][] = []
  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    chunks.push(pending.slice(i, i + CHUNK_SIZE))
  }

  for (const chunk of chunks) {
    const chunkIndex = nextChunkIndex++
    const recipients = chunk.map((r) => r.customer_wallet)
    const momentIds = chunk.map((r) => String(r.moment_id))
    const uniqueRecipients = new Set(recipients).size

    const { data: distRow, error: distInsErr } = await supabaseAdmin
      .from("break_distributions")
      .insert({
        break_id: id,
        chunk_index: chunkIndex,
        recipient_count: uniqueRecipients,
        moment_count: chunk.length,
        status: "pending",
      })
      .select("id")
      .single()
    if (distInsErr || !distRow) {
      console.log(`[breaks/distribute] dist insert failed chunk=${chunkIndex}: ${distInsErr?.message}`)
      failedCount++
      continue
    }
    const distributionId = distRow.id

    let txId: string
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      txId = await (fcl.mutate as any)({
        cadence: BREAK_MULTI_TRANSFER_TS,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: (arg: any) => [
          arg(recipients, t.Array(t.Address)),
          arg(momentIds, t.Array(t.UInt64)),
        ],
        proposer: authz,
        payer: authz,
        authorizations: [authz],
        limit: 9999,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[breaks/distribute] mutate failed chunk=${chunkIndex}: ${msg}`)
      await supabaseAdmin
        .from("break_distributions")
        .update({ status: "failed", error_message: `mutate: ${msg}` })
        .eq("id", distributionId)
      failedCount++
      continue
    }

    const broadcastIso = new Date().toISOString()
    await supabaseAdmin
      .from("break_distributions")
      .update({ status: "broadcast", broadcast_at: broadcastIso, tx_hash: txId })
      .eq("id", distributionId)

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await withTimeout((fcl.tx(txId) as any).onceSealed(), SEAL_TIMEOUT_MS, `seal ${txId}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[breaks/distribute] seal failed chunk=${chunkIndex} tx=${txId}: ${msg}`)
      await supabaseAdmin
        .from("break_distributions")
        .update({ status: "failed", error_message: `seal: ${msg}` })
        .eq("id", distributionId)
      failedCount++
      continue
    }

    const sealedIso = new Date().toISOString()
    const { error: distSealErr } = await supabaseAdmin
      .from("break_distributions")
      .update({ status: "sealed", sealed_at: sealedIso })
      .eq("id", distributionId)
    if (distSealErr) {
      console.log(`[breaks/distribute] dist seal-update failed chunk=${chunkIndex}: ${distSealErr.message}`)
    }

    const ids = chunk.map((r) => r.id)
    const { error: resUpdErr } = await supabaseAdmin
      .from("break_results")
      .update({
        transfer_status: "transferred",
        transfer_tx_hash: txId,
        transferred_at: sealedIso,
        distribution_id: distributionId,
      })
      .in("id", ids)
    if (resUpdErr) {
      console.log(`[breaks/distribute] result update failed chunk=${chunkIndex}: ${resUpdErr.message}`)
    }

    sealedCount++
    resultsTransferred += chunk.length
    console.log(
      `[breaks/distribute] sealed chunk=${chunkIndex} tx=${txId} moments=${chunk.length} recipients=${uniqueRecipients}`
    )
  }

  const allDone = await maybeMarkComplete(id)

  console.log(
    `[breaks/distribute] done break_id=${id} chunks=${chunks.length} sealed=${sealedCount} failed=${failedCount} transferred=${resultsTransferred} complete=${allDone} elapsed_ms=${Date.now() - startedAt}`
  )

  return NextResponse.json({
    ok: true,
    chunks_total: chunks.length,
    sealed: sealedCount,
    failed: failedCount,
    pending: chunks.length - sealedCount - failedCount,
    results_transferred: resultsTransferred,
    break_complete: allDone,
  })
}

async function maybeMarkComplete(breakId: string): Promise<boolean> {
  const { count: stillPending, error: countErr } = await supabaseAdmin
    .from("break_results")
    .select("id", { count: "exact", head: true })
    .eq("break_id", breakId)
    .neq("transfer_status", "transferred")
  if (countErr) {
    console.log(`[breaks/distribute] pending count failed: ${countErr.message}`)
    return false
  }
  const nowIso = new Date().toISOString()
  if ((stillPending ?? 0) === 0) {
    await supabaseAdmin
      .from("breaks")
      .update({ status: "complete", completed_at: nowIso })
      .eq("id", breakId)
    return true
  }
  await supabaseAdmin
    .from("breaks")
    .update({ status: "distributing" })
    .eq("id", breakId)
    .eq("status", "ripping")
  return false
}
