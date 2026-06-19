import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeTopShotSaleTx, decodeTopShotSaleTxViaSpork } from "@/lib/chains/flow/dapper-v1-tx-decode"

// POST /api/admin/backfill-topshot-buyers — Authorization: Bearer $INGEST_SECRET_TOKEN
//
// Top Shot sales were indexed buyer-blind for the platform's lifetime
// (buyer_address hardcoded null) because the MomentPurchased event carries only
// the seller. This route drains that history: for each null-buyer TS sale (any
// source — both the on-chain NFTStorefront feed and the GQL-ingested native
// marketplace feed) it fetches the on-chain transaction once and recovers the
// buyer (TopShot.Deposit.to) plus the execution accounts (payer/proposer) — the
// same decode the live sales-indexer now runs forward (Items 1+2, 2026-06-09).
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
// 100 (was 150, was 200). PER-ROW DECODE LATENCY governs runtime, not batch size:
// it drifted ~2.9s → ~3.9s/row, so BATCH=150 still ran ~585s (measured 589.8s,
// ~10s under cap) — the 25% batch cut didn't help because cost-per-row rose. At
// ~3.9s/row, 100 rows ≈ 390s, comfortably under maxDuration regardless of further
// latency drift. Above the 600s ceiling a run dies silently BEFORE the finally
// block writes its pipeline_runs row (invisible-failure class). Throughput stays
// fine: 100/run × ~10 runs/day ≈ 1,000/day ≫ the ~270/day new-null inflow.
const BATCH = 100
const TX_DECODE_DELAY_MS = 40
// Defense-in-depth wall-clock self-bound (2026-06-19): stop enqueuing new decodes
// once a single invocation has run this long, regardless of cron cadence, so it
// can NEVER approach the 800s Lambda cap even if BATCH or per-row latency drifts
// or the cron is later sped up. 600s leaves ~200s headroom for the in-flight row
// + the finally-block pipeline_runs write. The cursor advances to the oldest row
// actually processed (minSoldAt), so the unprocessed remainder (all older) stays
// in scope for the next pass — bailing early skips nothing. Throughput is
// unaffected (~270/day new-null inflow ≪ capacity).
const MAX_RUN_MS = 600_000

// ── Historical (spork) lane (2026-06-19, INERT by default) ───────────────────
// The forward lane above decodes via the CURRENT mainnet REST node, which only
// serves current-spork txs (~late-2024 onward) — so it can never resolve the
// 2022–2024 null-buyer tail (~42K rows), whose txs live in historical sporks.
// This lane (POST ?mode=historical) routes those through the spork-proxy worker
// (decodeTopShotSaleTxViaSpork → worker walks mainnet19→26). It is OFF unless
// TS_HISTORICAL_BUYER_BACKFILL_ENABLED=1 AND SPORK_PROXY_URL/SPORK_PROXY_SECRET
// are set, so it ships fully inert.
//
// OPERATOR ENABLE CHECKLIST (all required before flipping the flag):
//   1. `wrangler deploy` the updated workers/spork-proxy (adds the ?tx= route).
//   2. Verify one known 2022 TS sale tx decodes a buyer through the worker
//      (GET spork-proxy/?tx=<hex> with the Bearer secret → 200 + events).
//   3. Set SPORK_PROXY_URL + SPORK_PROXY_SECRET in Vercel env.
//   4. Set TS_HISTORICAL_BUYER_BACKFILL_ENABLED=1 and wire a low-cadence cron to
//      POST ?mode=historical (its own pipeline_runs row: topshot-buyer-backfill-historical).
// NOTE: the 2020–21 bulk (~137K rows) is pre-mainnet19 and NOT recoverable via
// the wired sporks — those return tx_not_found_in_listed_sporks and stay null.
// The window below excludes them so the lane doesn't burn its budget on them.
const HIST_PIPELINE_NAME = "topshot-buyer-backfill-historical"
const HIST_BATCH = 40 // spork walk is slower per row than current REST
const HIST_WINDOW_START = "2022-01-01T00:00:00Z" // ≥ this: in the wired sporks (mainnet19+)
const HIST_WINDOW_END = "2025-01-01T00:00:00Z"   // < this: pre current-spork (forward lane owns 2025+)

export const dynamic = "force-dynamic"
// 800 is the 800s Pro Lambda HARD cap (over 800 silently ERRORs the deploy — do
// not exceed). This is extra insurance, NOT a substitute for BATCH=100: BATCH
// bounds the runtime directly (~390s), whereas at 800 a latency spike could still
// hit the ceiling where a run dies before the finally block writes pipeline_runs.
export const maxDuration = 800

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

  // ── Historical (spork) lane — inert unless explicitly enabled + configured ──
  if (req.nextUrl.searchParams.get("mode") === "historical") {
    const enabled =
      process.env.TS_HISTORICAL_BUYER_BACKFILL_ENABLED === "1" ||
      process.env.TS_HISTORICAL_BUYER_BACKFILL_ENABLED === "true"
    const sporkUrl = process.env.SPORK_PROXY_URL ?? ""
    const sporkSecret = process.env.SPORK_PROXY_SECRET ?? ""
    if (!enabled || !sporkUrl || !sporkSecret) {
      return NextResponse.json({
        ok: true,
        queued: false,
        mode: "historical",
        skipped: !enabled ? "historical_disabled" : "spork_proxy_unconfigured",
      })
    }

    after(async () => {
      let cursorBefore: string | null = null
      let cursorAfter: string | null = null
      let found = 0
      let buyersResolved = 0
      let execResolved = 0
      let sellersFilled = 0
      let decodeFailed = 0
      let bailedEarly = false
      let ok = true
      let errMsg: string | null = null

      try {
        const { data: lastRun } = await (supabaseAdmin as any)
          .from("pipeline_runs")
          .select("extra")
          .eq("pipeline", HIST_PIPELINE_NAME)
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
          .is("buyer_address", null)
          .not("transaction_hash", "is", null)
          .gte("sold_at", HIST_WINDOW_START)
          .lt("sold_at", cursorBefore && cursorBefore < HIST_WINDOW_END ? cursorBefore : HIST_WINDOW_END)
          .order("sold_at", { ascending: false })
          .limit(HIST_BATCH)

        const { data, error } = await q
        if (error) {
          ok = false
          errMsg = error.message
          return
        }
        const rows = (data ?? []) as NullBuyerRow[]
        found = rows.length

        let minSoldAt: string | null = null
        for (const row of rows) {
          if (Date.now() - startedAt > MAX_RUN_MS) { bailedEarly = true; break }
          if (minSoldAt === null || row.sold_at < minSoldAt) minSoldAt = row.sold_at
          try {
            const dec = await decodeTopShotSaleTxViaSpork(
              String(row.transaction_hash), String(row.nft_id), sporkUrl, sporkSecret,
            )
            const patch: Record<string, unknown> = {}
            if (dec.buyer) patch.buyer_address = dec.buyer
            if (dec.payer) patch.payer_address = dec.payer
            if (dec.proposer) patch.proposer_address = dec.proposer
            if (!row.seller_address && dec.seller) patch.seller_address = dec.seller

            if (Object.keys(patch).length === 0) {
              decodeFailed++ // pre-mainnet19 (404) or transient — stays null, retried next pass
            } else {
              const { error: upErr } = await (supabaseAdmin as any)
                .from("sales").update(patch).eq("id", row.id).is("buyer_address", null)
              if (!upErr) {
                if (patch.buyer_address) buyersResolved++
                if (patch.payer_address || patch.proposer_address) execResolved++
                if (patch.seller_address) sellersFilled++
              }
            }
          } catch {
            decodeFailed++
          }
          await delay(TX_DECODE_DELAY_MS)
        }
        cursorAfter = rows.length < HIST_BATCH ? null : minSoldAt
      } catch (err) {
        ok = false
        errMsg = err instanceof Error ? err.message : String(err)
      } finally {
        try {
          await (supabaseAdmin as any).from("pipeline_runs").insert({
            pipeline: HIST_PIPELINE_NAME,
            collection_slug: "nba-top-shot",
            started_at: startedAtIso,
            finished_at: new Date().toISOString(),
            rows_found: found,
            rows_written: buyersResolved,
            rows_skipped: decodeFailed,
            ok,
            error: errMsg ? errMsg.slice(0, 500) : null,
            extra: {
              lane: "historical",
              cursor_sold_at: cursorAfter,
              cursor_before: cursorBefore,
              buyers_resolved: buyersResolved,
              exec_accounts_resolved: execResolved,
              sellers_filled: sellersFilled,
              decode_failed: decodeFailed,
              wrapped: cursorAfter === null,
              bailed_early: bailedEarly,
              duration_ms: Date.now() - startedAt,
            },
          })
        } catch { /* non-fatal */ }
      }
    })

    return NextResponse.json({
      ok: true,
      queued: true,
      mode: "historical",
      note: "Historical (spork) buyer backfill queued; progress in pipeline_runs (topshot-buyer-backfill-historical).",
    })
  }

  after(async () => {
    let cursorBefore: string | null = null
    let cursorAfter: string | null = null
    let found = 0
    let buyersResolved = 0
    let execResolved = 0
    let sellersFilled = 0
    let decodeFailed = 0
    let bailedEarly = false
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
        // Drains ALL null-buyer TS sales with a tx_hash, not just source='onchain'.
        // The TS native-marketplace population (GQL-ingested via /api/ingest) is
        // buyer- AND seller-blind; decodeTopShotSaleTx recovers both from the
        // TopShot.Deposit/.Withdraw events the same way (verified 2026-06-13).
        // source='onchain' rows are already 100% resolved, so re-including them is
        // a near-empty idempotent no-op (every UPDATE is gated on buyer IS NULL).
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
        // Wall-clock self-bound: stop before starting another ~4s decode once
        // we've burned the run budget. minSoldAt already reflects only processed
        // rows, so the cursor resumes correctly below them next pass.
        if (Date.now() - startedAt > MAX_RUN_MS) { bailedEarly = true; break }
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
            bailed_early: bailedEarly,
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
