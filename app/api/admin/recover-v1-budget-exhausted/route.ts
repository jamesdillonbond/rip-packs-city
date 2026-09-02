import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeV1SaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"

// ── AllDay V1-Dapper price recovery (Phase 2 of the unmapped-residue drain) ────
//
// The allday-sales-history-backfill parks V1-Dapper sales that overflow its
// per-tick decode budget into unmapped_sales with price_usd=0 and
// resolution_hint->>'price_extraction' = 'v1_tx_decode_budget_exhausted' (empty
// sample_duc_amounts — the tx was never decoded, NOT undecodable). DUC is
// USD-pegged, so a re-run of decodeV1SaleTx recovers price_usd directly; once a
// row has price>0 AND an edition (nft_edition_map, backfilled from sales by
// job 215) promote_unmapped_sales moves it into public.sales.
//
// This runs BOTH as a self-draining Vercel cron (CRON_SECRET) and as a manual
// admin one-shot (INGEST_SECRET_TOKEN). It is SYNCHRONOUS with a ~200s self-
// budget — NOT after()/waitUntil, whose tails die silently on Vercel (the
// documented backfill lesson) — and finalizes with margin under the 300s cap.
// Idempotent: sales rows are patched WHERE price_usd=0, unmapped rows strip the
// marker, so a second pass over the same tx is a no-op. Multi-NFT V1 txs are
// skipped (decodeV1SaleTx returns the gross DUC total, unsplittable per-NFT).
//
// New budget-exhausted rows keep arriving while the historical backfill runs, so
// this is a STANDING cron, not a one-shot — it no-ops cheaply once drained.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const CRON = process.env.CRON_SECRET ?? ""
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const COLLECTION_SLUG = "nfl_all_day"
const PIPELINE_NAME = "allday-price-recover"
const ALLDAY_DEPOSIT_EVENT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
const ALLDAY_WITHDRAW_EVENT = "A.e4cf4bdc1751c65d.AllDay.Withdraw"
const TX_DECODE_DELAY_MS = 80

// Rows to pull per tick. Flow REST shares a ~20 req/s project budget; each
// distinct tx costs one decode. The elapsed budget is the real limiter, this
// just bounds the initial read.
//
// ⚠ WAS 2000, WHICH THIS ROUTE NEVER GOT. The old read went straight at
// `unmapped_sales` through PostgREST, which CLAMPS a limit above 1,000 — and
// `extra.candidates` duly read exactly 1000 on every run for months, which is
// what the documented cap looks like from the outside when nobody checks the
// number against what was asked for. The claim is now an RPC that bounds
// p_limit itself, and 500 is a real number: at ~80 ms of pacing plus a Flow
// round-trip per decode, several hundred fit inside ELAPSED_BUDGET_MS.
const CANDIDATE_LIMIT = 500
const ELAPSED_BUDGET_MS = 200_000
const PROMOTE_LIMIT = 1000

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

interface UnmappedRow {
  id: string
  nft_id: string
  transaction_hash: string
  resolved_at: string | null
  resolution_hint: Record<string, unknown> | null
}

async function run(startedAt: string, startedMs: number) {
  const summary: Record<string, unknown> = {
    candidates: 0,
    distinct_txs: 0,
    tx_decode_ok: 0,
    tx_decode_fail: 0,
    skipped_multi_nft_rows: 0,
    updated_unmapped: 0,
    updated_sales: 0,
    still_uncertain: 0,
    promoted: 0,
    fail_reasons: {} as Record<string, number>,
    fatal: null as string | null,
  }
  let ok = true

  try {
    // ⚠ CLAIM THROUGH THE RPC, NOT THE TABLE — this is the fix, not a refactor.
    //
    // The old read selected from `unmapped_sales` with NO ORDER BY, so it got
    // PHYSICAL order: the same page on every tick. That page held 304 distinct
    // txs of which 303 were multi-NFT, so the loop below threw away 999 of
    // 1,000 rows and decoded ONE. Every run, for months, at `ok: true`.
    //
    // Measured 2026-09-02 — the population it was walking past:
    //   47,691 candidate rows over 21,409 txs
    //    9,859 SINGLETON txs, recoverable with one decode each   ← starved
    //   37,832 rows inside multi-NFT txs, unsplittable here
    // At one row per tick that backlog needs ~137 days; the elapsed budget can
    // do hundreds per tick once the candidates are the right ones.
    //
    // `claim_allday_v1_price_recovery_candidates` applies the singleton-tx test
    // in SQL and orders on the unique id.
    //
    // ⚠ It returns `resolution_hint` ON PURPOSE, and the first version of it did
    // not. The write path below rebuilds the hint from `row.resolution_hint`,
    // strips two keys and writes the object back — so with the column missing,
    // `?? {}` would have spread to an empty object and the UPDATE would have
    // REPLACED the hint on every recovered row, discarding every other key it
    // held. Caught before the route shipped; a claim that returns FEWER columns
    // is not free when the writer round-trips one of them.
    const { data, error } = await (supabaseAdmin as any).rpc(
      "claim_allday_v1_price_recovery_candidates",
      { p_limit: CANDIDATE_LIMIT },
    )
    if (error) {
      summary.fatal = `select:${error.message?.slice(0, 200)}`
      ok = false
    } else {
      const rows = (data ?? []) as UnmappedRow[]
      summary.candidates = rows.length

      // Group by tx. A multi-NFT V1 tx yields a single gross DUC that
      // decodeV1SaleTx cannot split per-NFT — flag and skip.
      const txGroups = new Map<string, UnmappedRow[]>()
      for (const r of rows) {
        const arr = txGroups.get(r.transaction_hash) ?? []
        arr.push(r)
        txGroups.set(r.transaction_hash, arr)
      }
      summary.distinct_txs = txGroups.size

      for (const [txHash, group] of txGroups) {
        if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
        if (group.length > 1) {
          summary.skipped_multi_nft_rows = (summary.skipped_multi_nft_rows as number) + group.length
          const key = "multi_nft_tx_total_unsplittable"
          ;(summary.fail_reasons as Record<string, number>)[key] =
            ((summary.fail_reasons as Record<string, number>)[key] ?? 0) + group.length
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
          summary.tx_decode_fail = (summary.tx_decode_fail as number) + 1
          summary.still_uncertain = (summary.still_uncertain as number) + 1
          ;(summary.fail_reasons as Record<string, number>)[decoded.priceReason] =
            ((summary.fail_reasons as Record<string, number>)[decoded.priceReason] ?? 0) + 1
          continue
        }
        summary.tx_decode_ok = (summary.tx_decode_ok as number) + 1
        const priceUsd = decoded.priceDuc

        if (row.resolved_at) {
          // Already promoted at price 0 (pre-2026-05-25 guard) — fix in place.
          // WHERE price_usd=0 keeps it idempotent.
          const { data: updated, error: salesErr } = await (supabaseAdmin as any)
            .from("sales")
            .update({ price_usd: priceUsd, price_native: priceUsd })
            .eq("collection_id", ALLDAY_COLLECTION_ID)
            .eq("transaction_hash", txHash)
            .eq("price_usd", 0)
            .select("id")
          if (salesErr) {
            console.log(`[${PIPELINE_NAME}] sales update err tx=${txHash}: ${salesErr.message}`)
            continue
          }
          summary.updated_sales = (summary.updated_sales as number) + (updated?.length ?? 0)
        } else {
          // Still unmapped — strip the marker so promote (price>0 + edition) can
          // take it.
          const cleaned: Record<string, unknown> = { ...(row.resolution_hint ?? {}) }
          delete cleaned.price_extraction
          delete cleaned.sample_duc_amounts
          const { error: umErr } = await (supabaseAdmin as any)
            .from("unmapped_sales")
            .update({ price_usd: priceUsd, price_native: priceUsd, resolution_hint: cleaned })
            .eq("id", row.id)
          if (umErr) {
            console.log(`[${PIPELINE_NAME}] unmapped update err id=${row.id}: ${umErr.message}`)
            continue
          }
          summary.updated_unmapped = (summary.updated_unmapped as number) + 1
        }
      }

      // Drain anything now price>0 AND edition-resolvable.
      try {
        const { data: pr, error: prErr } = await (supabaseAdmin as any).rpc("promote_unmapped_sales", {
          p_collection_id: ALLDAY_COLLECTION_ID,
          p_limit: PROMOTE_LIMIT,
        })
        // ⛔ supabase-js RETURNS an rpc error rather than throwing, so the
        // surrounding try/catch never saw one and `?? 0` published a MEASURED
        // ZERO: an operator running this recovery by hand read "promoted: 0" —
        // "there was nothing to promote" — out of a call that failed. This route
        // exists to be read by a human during an incident, which is exactly when
        // a fabricated zero is most expensive. It does not throw (the caller may
        // still want the rest of the summary); it reports null and says why.
        if (prErr) {
          summary.promoted = null
          summary.promote_error = prErr.message
          console.log(`[${PIPELINE_NAME}] promote rpc err: ${prErr.message}`)
        } else {
          summary.promoted = Number((pr as any)?.promoted ?? 0) || 0
        }
        // 2026-08-30: the drain skips itself for 20 min after a real run; surface that
        // so a manual recovery does not read a throttled tick as "nothing promoted".
        if ((pr as any)?.skipped) summary.promote_skipped = String((pr as any).skipped)
      } catch (e) {
        console.log(`[${PIPELINE_NAME}] promote err: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (err) {
    ok = false
    summary.fatal = err instanceof Error ? err.message.slice(0, 300) : String(err)
    console.log(`[${PIPELINE_NAME}] fatal: ${summary.fatal}`)
  }

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: summary.candidates,
      p_rows_written: (summary.updated_unmapped as number) + (summary.updated_sales as number),
      p_rows_skipped: summary.skipped_multi_nft_rows,
      p_ok: ok,
      p_error: (summary.fatal as string) ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { ...summary, duration_ms: Date.now() - startedMs },
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log err: ${e instanceof Error ? e.message : String(e)}`)
  }

  console.log(
    `[${PIPELINE_NAME}] candidates=${summary.candidates} txs=${summary.distinct_txs} ok=${summary.tx_decode_ok} fail=${summary.tx_decode_fail} unmapped=${summary.updated_unmapped} sales=${summary.updated_sales} promoted=${summary.promoted}`,
  )
  return { ok, summary }
}

async function handle(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const authedOk =
    (TOKEN.length > 0 && (bearer === TOKEN || urlToken === TOKEN)) ||
    (CRON.length > 0 && (bearer === CRON || urlToken === CRON))
  if (!authedOk) return unauthorized()

  const startedAt = new Date().toISOString()
  const { ok, summary } = await run(startedAt, Date.now())
  return NextResponse.json({ ok, pipeline: PIPELINE_NAME, ...summary }, { status: ok ? 200 : 500 })
}

export async function POST(req: NextRequest) {
  return handle(req)
}
export async function GET(req: NextRequest) {
  return handle(req)
}
