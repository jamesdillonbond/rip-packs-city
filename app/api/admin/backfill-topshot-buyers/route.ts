import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeTopShotSaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"

// POST /api/admin/backfill-topshot-buyers — Authorization: Bearer $INGEST_SECRET_TOKEN
//
// Top Shot sales were indexed buyer-blind for the platform's lifetime
// (buyer_address hardcoded null) because the MomentPurchased event carries only
// the seller. This route drains that history: for each null-buyer TS onchain
// sale it fetches the on-chain transaction once and recovers the buyer
// (TopShot.Deposit.to) plus the execution accounts (payer/proposer) — the same
// decode the live sales-indexer now runs forward (Items 1+2, 2026-06-09).
//
// Resumable + idempotent: it walks sold_at DESCENDING via a cursor stored in
// pipeline_runs.extra->>cursor_sold_at. Each run fixes a window and records the
// oldest sold_at it reached; the next run continues below that. When it reaches
// the bottom (a short/empty batch) the cursor wraps back to NULL so the next run
// starts another top-down pass — retrying any rows that transiently failed to
// decode. Every UPDATE is gated on buyer_address IS NULL, so re-runs are safe.
// Wire a temporary cron until the null-buyer backlog drains, then disable.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "topshot-buyer-backfill"
const BATCH = 300
const TX_DECODE_DELAY_MS = 40

export const dynamic = "force-dynamic"
export const maxDuration = 300

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

interface NullBuyerRow {
  id: string
  nft_id: string
  transaction_hash: string
  sold_at: string
  seller_address: string | null
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()
  const startedAt = Date.now()

  after(async () => {
    let cursorBefore: string | null = null
    let cursorAfter: string | null = null
    let found = 0
    let buyersResolved = 0
    let execResolved = 0
    let sellersFilled = 0
    let decodeFailed = 0
    let ok = true
    let errMsg: string | null = null

    try {
      // Resume cursor from the last run.
      const { data: lastRun } = await (supabaseAdmin as any)
        .from("pipeline_runs")
        .select("extra")
        .eq("pipeline", PIPELINE_NAME)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      cursorBefore =
        (lastRun?.extra && typeof lastRun.extra.cursor_sold_at === "string"
          ? lastRun.extra.cursor_sold_at
          : null) ?? null

      let q = (supabaseAdmin as any)
        .from("sales")
        .select("id, nft_id, transaction_hash, sold_at, seller_address")
        .eq("collection", "nba_top_shot")
        .eq("source", "onchain")
        .is("buyer_address", null)
        .not("transaction_hash", "is", null)
        .order("sold_at", { ascending: false })
        .limit(BATCH)
      if (cursorBefore) q = q.lt("sold_at", cursorBefore)

      const { data, error } = await q
      if (error) {
        ok = false
        errMsg = error.message
        console.log(`[backfill-topshot-buyers] select err: ${error.message}`)
        return
      }
      const rows = (data ?? []) as NullBuyerRow[]
      found = rows.length

      let minSoldAt: string | null = null
      for (const row of rows) {
        if (minSoldAt === null || row.sold_at < minSoldAt) minSoldAt = row.sold_at
        try {
          const dec = await decodeTopShotSaleTx(String(row.transaction_hash), String(row.nft_id))
          const patch: Record<string, unknown> = {}
          if (dec.buyer) patch.buyer_address = dec.buyer
          if (dec.payer) patch.payer_address = dec.payer
          if (dec.proposer) patch.proposer_address = dec.proposer
          if (!row.seller_address && dec.seller) patch.seller_address = dec.seller

          if (Object.keys(patch).length === 0) {
            decodeFailed++
          } else {
            const { error: upErr } = await (supabaseAdmin as any)
              .from("sales")
              .update(patch)
              .eq("id", row.id)
              .is("buyer_address", null)
            if (upErr) {
              console.log(`[backfill-topshot-buyers] update err id=${row.id}: ${upErr.message}`)
            } else {
              if (patch.buyer_address) buyersResolved++
              if (patch.payer_address || patch.proposer_address) execResolved++
              if (patch.seller_address) sellersFilled++
            }
          }
        } catch (err) {
          decodeFailed++
          console.log(
            `[backfill-topshot-buyers] decode err tx=${row.transaction_hash}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await delay(TX_DECODE_DELAY_MS)
      }

      // Short batch ⇒ reached the bottom of the null-buyer set for this pass;
      // wrap the cursor so the next run starts a fresh top-down sweep.
      cursorAfter = rows.length < BATCH ? null : minSoldAt
    } catch (err) {
      ok = false
      errMsg = err instanceof Error ? err.message : String(err)
      console.log(`[backfill-topshot-buyers] fatal: ${errMsg}`)
    } finally {
      try {
        await (supabaseAdmin as any).from("pipeline_runs").insert({
          pipeline: PIPELINE_NAME,
          collection_slug: "nba-top-shot",
          started_at: startedAtIso,
          finished_at: new Date().toISOString(),
          rows_found: found,
          rows_written: buyersResolved,
          rows_skipped: decodeFailed,
          ok,
          error: errMsg ? errMsg.slice(0, 500) : null,
          extra: {
            cursor_sold_at: cursorAfter,
            cursor_before: cursorBefore,
            buyers_resolved: buyersResolved,
            exec_accounts_resolved: execResolved,
            sellers_filled: sellersFilled,
            decode_failed: decodeFailed,
            wrapped: cursorAfter === null,
            duration_ms: Date.now() - startedAt,
          },
        })
      } catch (logErr) {
        console.log(
          `[backfill-topshot-buyers] pipeline_runs insert threw: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
        )
      }
      console.log(
        `[backfill-topshot-buyers] done found=${found} buyers=${buyersResolved} exec=${execResolved} failed=${decodeFailed} cursorAfter=${cursorAfter}`,
      )
    }
  })

  return NextResponse.json({
    ok: true,
    queued: true,
    note: "Top Shot buyer + execution-account backfill queued; progress in pipeline_runs (topshot-buyer-backfill).",
  })
}
