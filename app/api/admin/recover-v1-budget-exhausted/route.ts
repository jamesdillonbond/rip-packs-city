import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeV1SaleTx } from "@/lib/dapper-v1-tx-decode"

// POST /api/admin/recover-v1-budget-exhausted — Authorization: Bearer $INGEST_SECRET_TOKEN
//
// One-shot reprocessor for the V1-Dapper NFTStorefront AllDay sales that were
// written with price_usd=0 during the 2026-05-18..23 indexer catch-up burst.
// During that burst, ticks with more V1 cache-miss sales than the
// V1_TX_DECODE_MAX=25 budget would queue the overflow into unmapped_sales with
// resolution_hint->>'price_extraction'='v1_tx_decode_budget_exhausted'. The
// promote_unmapped_sales guard was strengthened on 2026-05-25 (migration
// audit_20260525_promote_unmapped_sales_skip_nonpositive_price) from
// "price_usd IS NOT NULL" to "COALESCE(price_usd,0) > 0", so no new zero-price
// rows can leak — but ~195 historical rows had already promoted into
// public.sales with price_usd=0 before the guard landed.
//
// Strategy: re-run decodeV1SaleTx for each tx_hash. DUC is USD-pegged, so
// priceDuc maps directly to price_usd. For rows still in unmapped_sales,
// patch price + strip the marker key so the resolver + promote can take it
// the rest of the way. For rows already in public.sales, UPDATE the row in
// place (matched on collection_id + transaction_hash + price_usd=0).
//
// Multi-NFT V1 txs are skipped: decodeV1SaleTx sums all DUC TokensWithdrawn
// from the DUC contract address across the tx, so a 4-NFT tx returns the
// gross total -- not a per-NFT price. Today there are exactly 2 such txs
// (8 rows of 257). Counted under summary.skippedMultiNftTx and reported in
// summary.failReasons so a manual splitter can pick them up later.
//
// Fire-and-forget via after(); result lands in Vercel runtime logs only.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const ALLDAY_DEPOSIT_EVENT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
const ALLDAY_WITHDRAW_EVENT = "A.e4cf4bdc1751c65d.AllDay.Withdraw"
const TX_DECODE_DELAY_MS = 100

export const dynamic = "force-dynamic"
export const maxDuration = 300

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

interface UnmappedRow {
  id: string
  nft_id: string
  transaction_hash: string
  resolved_at: string | null
  resolution_hint: Record<string, unknown> | null
}

export async function POST(req: NextRequest) {
  if (!TOKEN || req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = Date.now()

  after(async () => {
    const summary = {
      totalRows: 0,
      distinctTxs: 0,
      txDecodeOk: 0,
      txDecodeFail: 0,
      skippedMultiNftTxRows: 0,
      updatedUnmappedSales: 0,
      updatedSales: 0,
      stillUncertain: 0,
      failReasons: {} as Record<string, number>,
      durationMs: 0,
    }

    try {
      const { data, error } = await (supabaseAdmin as any)
        .from("unmapped_sales")
        .select("id, nft_id, transaction_hash, resolved_at, resolution_hint")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .eq("resolution_hint->>price_extraction", "v1_tx_decode_budget_exhausted")
      if (error) {
        console.log(`[recover-v1-budget-exhausted] select err: ${error.message}`)
        return
      }
      const rows = (data ?? []) as UnmappedRow[]
      summary.totalRows = rows.length

      // Group by tx_hash. A multi-NFT V1 tx produces a single DUC gross that
      // cannot be split per-NFT by decodeV1SaleTx, so flag and skip.
      const txGroups = new Map<string, UnmappedRow[]>()
      for (const r of rows) {
        const arr = txGroups.get(r.transaction_hash) ?? []
        arr.push(r)
        txGroups.set(r.transaction_hash, arr)
      }
      summary.distinctTxs = txGroups.size

      for (const [txHash, group] of txGroups) {
        if (group.length > 1) {
          summary.skippedMultiNftTxRows += group.length
          const key = "multi_nft_tx_total_unsplittable"
          summary.failReasons[key] = (summary.failReasons[key] ?? 0) + group.length
          continue
        }
        const row = group[0]
        const decoded = await decodeV1SaleTx(txHash, {
          depositEventType: ALLDAY_DEPOSIT_EVENT,
          withdrawEventType: ALLDAY_WITHDRAW_EVENT,
          nftId: row.nft_id,
        })
        await delay(TX_DECODE_DELAY_MS)

        if (!decoded.priceCertain || decoded.priceDuc == null) {
          summary.txDecodeFail++
          summary.stillUncertain++
          summary.failReasons[decoded.priceReason] =
            (summary.failReasons[decoded.priceReason] ?? 0) + 1
          continue
        }
        summary.txDecodeOk++
        const priceUsd = decoded.priceDuc

        if (row.resolved_at) {
          // Already promoted into public.sales at price_usd=0 -- fix in place.
          // WHERE price_usd=0 keeps this idempotent: a second run won't match.
          const { data: updated, error: salesErr } = await (supabaseAdmin as any)
            .from("sales")
            .update({ price_usd: priceUsd, price_native: priceUsd })
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .eq("transaction_hash", txHash)
            .eq("price_usd", 0)
            .select("id")
          if (salesErr) {
            console.log(
              `[recover-v1-budget-exhausted] sales update err tx=${txHash}: ${salesErr.message}`
            )
            continue
          }
          summary.updatedSales += updated?.length ?? 0
        } else {
          // Still in unmapped_sales -- strip the marker so promote_unmapped_sales
          // (guarded at >0) can take it on the next sweep.
          const cleaned: Record<string, unknown> = { ...(row.resolution_hint ?? {}) }
          delete cleaned.price_extraction
          delete cleaned.sample_duc_amounts
          const { error: umErr } = await (supabaseAdmin as any)
            .from("unmapped_sales")
            .update({
              price_usd: priceUsd,
              price_native: priceUsd,
              resolution_hint: cleaned,
            })
            .eq("id", row.id)
          if (umErr) {
            console.log(
              `[recover-v1-budget-exhausted] unmapped_sales update err id=${row.id}: ${umErr.message}`
            )
            continue
          }
          summary.updatedUnmappedSales++
        }
      }
    } catch (err) {
      console.log(
        `[recover-v1-budget-exhausted] fatal: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      summary.durationMs = Date.now() - startedAt
      console.log(`[recover-v1-budget-exhausted] done ${JSON.stringify(summary)}`)
    }
  })

  return NextResponse.json({
    ok: true,
    queued: true,
    note:
      "V1-Dapper budget-exhausted recovery queued; result logged to Vercel runtime logs.",
  })
}
