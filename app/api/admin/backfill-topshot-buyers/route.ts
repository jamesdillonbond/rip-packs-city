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

// ── Exec-account fill (2026-10-10) ───────────────────────────────────────────
// The buyer lanes select `buyer_address IS NULL`, so a sale whose BUYER another
// writer filled first was never decoded for payer/proposer — the execution-venue
// signal that makes a new front-end visible. Measured 2026-10-09: 4,948 of 13,366
// Top Shot `onchain` sales over 7 days had a buyer and no payer, and daily payer
// coverage sat at 33–75 % for three weeks without rising as rows aged. This phase
// runs after the buyer loop and fills payer/proposer ONLY, gated on
// `payer_address IS NULL`, over a short recent window.
// Why the window and not a cursor: the payer comes from the tx envelope
// (parseTopShotSaleTxJson), so any fetchable tx yields one and a row cannot stay
// payer-null for a decoded reason — only a fetch failure, which ages out of the
// window instead of being re-decoded forever (the treadmill the historical lane
// documents). Capacity: 80 × ~48 runs/day ≈ 3,800 ≫ the ~1,000/day inflow
// (3-day backlog 2,979 on 2026-10-10; batch read ~113 buffers, backlog count ~4k).
const EXEC_FILL_BATCH = 80
const EXEC_FILL_WINDOW_DAYS = 3

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
// NOTE: recoverable floor RE-MEASURED 2026-08-30 — IT MOVED. The 2026-06-25 floor was
// mainnet17 (2022-04-06), but on ~2026-08-28/29 the public historical access nodes for
// mainnet17–23 were decommissioned outright (access-001.mainnetNN.nodes.onflow.org: no
// DNS at all; probed per-spork 2026-08-30 17:xxZ — 17–23 dead, 24–27 answer HTTP 200).
// The effect in production: from 08-29 the lane's cursor stalled at exactly
// 2023-11-08 (the mainnet24 root: height 65,264,619 @ 2023-11-08T16:07:03Z, read from
// the live node) and every run was 120/120 decode_404 with spork_floor=true — 48
// runs/day of pure 404 walking plus a ~60k-block candidate scan each, for zero buyers.
// So the recoverable floor is now the mainnet24 root: sold_at before 2023-11-08T16:07:03Z
// (including the whole 2022-04→2023-11 band the June floor could still reach) is
// permanently unrecoverable via public sporks and stays null. If Flow ever restores
// older sporks, lower this constant again — the null rows are all still there.
// (Requires the extended spork-proxy to be deployed + SPORK_PROXY_URL/SECRET set in
// Vercel; until then this lane is inert behind TS_HISTORICAL_BUYER_BACKFILL_ENABLED.)
const HIST_PIPELINE_NAME = "topshot-buyer-backfill-historical"
const HIST_BATCH = 120 // recent-spork rows decode fast; the MAX_RUN_MS guard + cursor advance bound the run regardless
const HIST_WINDOW_START = "2023-11-08T16:07:03Z" // ≥ this: reachable via the surviving sporks (mainnet24 root floor; was 2022-04-06 / mainnet17 until 2026-08-28)
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
      // ⚠ SPLIT BY REASON (2026-08-29). `decode_failed` alone cannot distinguish
      // "this era is gone" from "our credential broke", and this lane sat at 100%
      // decode_failed for 36 runs with no way to tell. A 404 is the spork floor —
      // expected and permanent. Anything else is ours to fix.
      let decode404 = 0
      let decodeOtherStatus = 0
      let firstBadStatus: number | null = null
      let bailedEarly = false
      // Rows in the window this lane has ALREADY decoded to exhaustion. Reported
      // rather than merely excluded: a predicate that silently shrinks a
      // population turns "nothing left to do" and "we stopped looking" into the
      // same reading, which is the defect this whole change exists to remove.
      let exhaustedInWindow = 0
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

        // ⚠ `payer_address IS NULL` IS LOAD-BEARING, AND IT IS THE FIX FOR A TREADMILL
        // THIS LANE RAN FOR DAYS (2026-09-02).
        //
        // Measured: 47 runs/day, `rows_found` 45 EVERY run, `buyers_resolved` 0 every
        // run, `decode_404`/`decode_failed`/`decode_other_status` all 0, `wrapped:
        // true`, cursor never set. The window held exactly 45 null-buyer rows and ALL
        // 45 already carried a payer AND a proposer — i.e. every one had already been
        // decoded successfully by this lane, which found exec accounts and no buyer.
        // Because a buyer-less row keeps `buyer_address IS NULL` it was re-selected
        // next run, re-decoded through the spork proxy, and re-UPDATEd with the
        // identical payer/proposer: **2,115 proxy decodes and 2,115 no-op row versions
        // a day on a partitioned `sales`, forever, at `ok: true` with `rows_written: 0`
        // reading exactly like "nothing to do".**
        //
        // A decoded tx is IMMUTABLE, so re-running the SAME decoder over it cannot
        // produce a different answer — the row is terminal for this lane. On Top Shot
        // sales `payer_address` is only ever written by a tx decode (this route's two
        // lanes and `sales-indexer`), so `payer set AND buyer null` means exactly
        // "decoded, no buyer recoverable".
        //
        // 👉 THE ONE CASE THAT UN-SKIPS THEM: a CHANGED decoder. If
        // `decodeTopShotSaleTxViaSpork` learns a new buyer path, these rows are
        // candidates again — run a one-off pass with this predicate removed rather
        // than deleting it here, and watch `exhausted_in_window` fall.
        let q = (supabaseAdmin as any)
          .from("sales")
          .select("id, nft_id, transaction_hash, sold_at, seller_address")
          .eq("collection", "nba_top_shot")
          .is("buyer_address", null)
          .is("payer_address", null)
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

        // The excluded population, counted rather than assumed. `head: true` so this
        // costs a count and not a page, and the error is NOT swallowed into 0 — a
        // failed count published as a measured zero is the fabricated-number shape.
        const { count: exhaustedCount, error: exhaustedErr } = await (supabaseAdmin as any)
          .from("sales")
          .select("id", { count: "exact", head: true })
          .eq("collection", "nba_top_shot")
          .is("buyer_address", null)
          .not("payer_address", "is", null)
          .not("transaction_hash", "is", null)
          .gte("sold_at", HIST_WINDOW_START)
          .lt("sold_at", HIST_WINDOW_END)
        exhaustedInWindow = exhaustedErr ? -1 : (exhaustedCount ?? -1)

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
              decodeFailed++ // stays null, retried next pass
              if (dec.status === 404) {
                decode404++
              } else if (typeof dec.status === "number") {
                decodeOtherStatus++
                if (firstBadStatus === null) firstBadStatus = dec.status
              }
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
          // write-discarded: run telemetry; a failed log row cannot change what the run did, and shows up as a missing run.
          await (supabaseAdmin as any).from("pipeline_runs").insert({
            pipeline: HIST_PIPELINE_NAME,
            collection_slug: "nba-top-shot",
            started_at: startedAtIso,
            finished_at: new Date().toISOString(),
            rows_found: found,
            rows_written: buyersResolved,
            rows_skipped: decodeFailed,
            // ⚠ A run whose every lookup failed for a reason that is OURS is not a
            // success. The spork floor is NOT such a reason — it is the expected
            // end of the resolvable range — so it stays green and is reported via
            // `spork_floor` instead. Anything else at 100% (auth, proxy down) is a
            // real failure that was previously indistinguishable from the floor.
            ok: ok && !(found > 0 && buyersResolved === 0 && decodeOtherStatus > 0 && decode404 === 0),
            error:
              errMsg
                ? errMsg.slice(0, 500)
                : found > 0 && buyersResolved === 0 && decodeOtherStatus > 0 && decode404 === 0
                  ? `resolved 0 of ${found}; ${decodeOtherStatus} spork lookups failed with status ${firstBadStatus ?? "unknown"} (NOT the mainnet19 floor)`
                  : null,
            extra: {
              lane: "historical",
              cursor_sold_at: cursorAfter,
              cursor_before: cursorBefore,
              buyers_resolved: buyersResolved,
              exec_accounts_resolved: execResolved,
              sellers_filled: sellersFilled,
              decode_failed: decodeFailed,
              // Always emitted, including as 0 — an absent key cannot answer "how
              // many were the floor vs our fault", which is the whole point.
              decode_404: decode404,
              decode_other_status: decodeOtherStatus,
              first_bad_status: firstBadStatus,
              // ⭐ The floor signal the AllDay sibling already has
              // (`reached_spork_floor_hint`) and this lane did not: every row
              // attempted, none resolved, and every failure a 404. That is the
              // cursor having walked past mainnet19, not a fault — and it means
              // further passes over this range can only ever write zero.
              spork_floor: found > 0 && buyersResolved === 0 && decode404 === found,
              // -1 means the count itself failed. It is deliberately NOT 0: a
              // failed read rendered as a measured zero would say "nothing is
              // parked" when the truth is "we could not look".
              exhausted_in_window: exhaustedInWindow,
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
    let execFillFound = 0
    let execFilled = 0
    let execFillFailed = 0
    // -1 = the count itself failed (never published as a measured 0).
    let execFillBacklog = -1
    let execFillError: string | null = null
    // Rows the payer filter skips (decoded, no buyer recoverable). Counted only on
    // the run that WRAPS (≈ once a day): the count measured 9.8 s / 18k buffers,
    // too dear for every run. null = not counted this run; -1 = the count failed.
    let exhaustedInWindow: number | null = null

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
        // ⚠ `payer_address IS NULL` — the historical lane's treadmill fix, which
        // this lane lacked until 2026-10-10. Measured: 4,987 `topshot_marketplace`
        // rows (2025-12-29 → 2026-04-14) already carried a payer and no
        // recoverable buyer, and every daily pass re-decoded and re-UPDATEd all
        // of them: ~4,770 decodes + ~4,770 identical row versions a day, 0 buyers
        // (the only buyers in 3 days, 179 on 10-08, came from payer-null rows).
        // A decoded tx is immutable, and payer is only ever written by a decode,
        // so `payer set AND buyer null` is terminal for the same decoder. They
        // are counted once per pass as `exhausted` (below), not hidden. A CHANGED
        // decoder un-skips them: run a one-off pass with this filter removed.
        .is("payer_address", null)
        .not("transaction_hash", "is", null)
        // Forward lane owns 2025+ only; the pre-current-spork rows below this bound
        // can't be decoded via current-spork REST (that's the historical lane's job)
        // and just churn the cursor at rows_written≈0. Bounding here also lets the
        // planner partition-prune to sales_2025/sales_2026.
        .gte("sold_at", HIST_WINDOW_END)
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

      if (cursorAfter === null) {
        const { count: exhaustedCount, error: exhaustedErr } = await (supabaseAdmin as any)
          .from("sales")
          .select("id", { count: "exact", head: true })
          .eq("collection", "nba_top_shot")
          .is("buyer_address", null)
          .not("payer_address", "is", null)
          .not("transaction_hash", "is", null)
          .gte("sold_at", HIST_WINDOW_END)
        exhaustedInWindow = exhaustedErr ? -1 : (exhaustedCount ?? -1)
      }

      // Exec-account fill (see EXEC_FILL_BATCH). Skipped when the buyer loop
      // already spent the run budget; its rows stay in the window for next run.
      if (!bailedEarly) {
        const windowStart = new Date(Date.now() - EXEC_FILL_WINDOW_DAYS * 86_400_000).toISOString()
        const { data: execData, error: execErr } = await (supabaseAdmin as any)
          .from("sales")
          .select("id, nft_id, transaction_hash, sold_at")
          .eq("collection", "nba_top_shot")
          .not("buyer_address", "is", null)
          .is("payer_address", null)
          .not("transaction_hash", "is", null)
          .gte("sold_at", windowStart)
          .order("sold_at", { ascending: false })
          .order("id", { ascending: true })
          .limit(EXEC_FILL_BATCH)
        if (execErr) {
          execFillError = execErr.message
        } else {
          const execRows = (execData ?? []) as Array<{ id: string; nft_id: string; transaction_hash: string }>
          execFillFound = execRows.length
          for (const row of execRows) {
            if (Date.now() - startedAt > MAX_RUN_MS) { bailedEarly = true; break }
            try {
              const dec = await decodeTopShotSaleTx(String(row.transaction_hash), String(row.nft_id))
              const patch: Record<string, unknown> = {}
              if (dec.payer) patch.payer_address = dec.payer
              if (dec.proposer) patch.proposer_address = dec.proposer
              if (Object.keys(patch).length === 0) {
                execFillFailed++
              } else {
                const { error: upErr } = await (supabaseAdmin as any)
                  .from("sales")
                  .update(patch)
                  .eq("id", row.id)
                  .is("payer_address", null)
                if (upErr) {
                  execFillFailed++
                  if (!execFillError) execFillError = upErr.message
                } else {
                  execFilled++
                }
              }
            } catch {
              execFillFailed++
            }
            await delay(TX_DECODE_DELAY_MS)
          }
        }
        // What is still waiting after this run, counted (head: true) not assumed.
        const { count: backlogCount, error: backlogErr } = await (supabaseAdmin as any)
          .from("sales")
          .select("id", { count: "exact", head: true })
          .eq("collection", "nba_top_shot")
          .not("buyer_address", "is", null)
          .is("payer_address", null)
          .not("transaction_hash", "is", null)
          .gte("sold_at", windowStart)
        execFillBacklog = backlogErr ? -1 : (backlogCount ?? -1)
        // A failed read or write in this phase fails the RUN: `ok` must say the
        // lanes worked, not merely that the route got to the end.
        if (execFillError) {
          ok = false
          errMsg = `exec fill: ${execFillError}`
        }
      }
    } catch (err) {
      ok = false
      errMsg = err instanceof Error ? err.message : String(err)
      console.log(`[backfill-topshot-buyers] fatal: ${errMsg}`)
    } finally {
      try {
        // write-discarded: run telemetry; a failed log row cannot change what the run did, and shows up as a missing run.
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
            exec_fill_found: execFillFound,
            exec_fill_written: execFilled,
            exec_fill_failed: execFillFailed,
            exec_fill_backlog: execFillBacklog,
            exec_fill_error: execFillError,
            exhausted_in_window: exhaustedInWindow,
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
