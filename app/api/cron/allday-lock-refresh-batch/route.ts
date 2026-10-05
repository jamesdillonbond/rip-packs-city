import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { refreshAllDayWalletLocks, AllDayLockDeadlineError } from "@/lib/allday-lock"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

// Scheduled All Day lock-refresh batch.
//
// All Day has no per-NFT isLocked() primitive, so lock-check-batch cannot
// service it (it lands All Day under unsupported_collections). This route is
// the All Day analogue: it walks the stalest All Day wmc wallets (never-checked
// first, via get_allday_lock_refresh_wallets), and for each recomputes
// is_locked + lock_checked_at from the on-chain unlocked-id diff (whale-safe
// chunked Cadence, lib/allday-lock.ts).
//
// There are only a few hundred All Day wmc wallets (all seeded/saved), one
// Cadence diff each. A wallet is re-walked once a day (REVERIFY_AFTER_MS, below);
// stalest-first ordering means never-checked rows are dated on the next tick.
//
// Bearer INGEST_SECRET_TOKEN or CRON_SECRET. CRON-30S: real work runs in
// after() and returns 202 immediately, matching lock-check-batch.

export const maxDuration = 300
export const dynamic = "force-dynamic"

const PIPELINE_NAME = "allday-lock-refresh"
// 2026-10-04: 60 → 12, and a wallet is re-verified only once its oldest check is
// REVERIFY_AFTER_MS old. Since the 09-28 paging fix every walk stamps EVERY row in
// the wallet, and at 60 wallets/tick the whole population (239 wallets, 428,896
// rows) was re-walked every ~4 h: ~2.6M lock_checked_at writes/day (≈320k before
// 09-28) for 0–6 flips per tick. lock_checked_at sits in four indexes, so each
// stamp is a non-HOT update touching all 20 wallet_moments_cache indexes — two of
// them were back under 60% leaf density within 2 h of the weekly REINDEX and the
// 10-04 wmc-reindex-verify failed. One pass a day keeps the readers' 7-day promise
// (LOCK_MAX_AGE_DAYS) with 6× margin. Never-checked rows (NULL) are still due at
// once, and 12/tick (288/day of capacity) spreads the passes across the day
// instead of re-walking the population in one burst.
const WALLET_FETCH = 12 // candidate wallets pulled per tick; the soft deadline caps how many run
const REVERIFY_AFTER_MS = 24 * 3600_000
// 2026-09-28: 270 s → 200 s. A wallet now walks the chain in a few calls, but a
// whale's write phase (tens of thousands of stamped rows) runs AFTER its walk,
// so a wallet started at 270 s could still be writing at the 300 s wall. The
// same value bounds the walk itself (no window starts past it).
const SOFT_DEADLINE_MS = 200_000

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  return (
    !!bearer &&
    (bearer === process.env.INGEST_SECRET_TOKEN || bearer === process.env.CRON_SECRET)
  )
}

export async function POST(req: NextRequest) {
  return handle(req)
}
export async function GET(req: NextRequest) {
  return handle(req)
}

function handle(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const startedAtIso = new Date().toISOString()
  after(async () => {
    // Invocation heartbeat, written BEFORE the work and awaited.
    //
    // ⚠ `try/catch` CANNOT catch a `maxDuration` kill: the platform terminates
    // the function and takes the terminal `log_pipeline_run` below with it, while
    // the 202 has already told the caller this succeeded. Without a marker written
    // first, a killed tick is indistinguishable from a cron that never fired — and
    // the catch below is NOT a backstop for it.
    //
    // ⭐ SELECTED ON MEASURED KILL RISK, and this route has the tightest margin
    // in the fleet. Over the 73 h `pipeline_runs` retains (read 2026-09-02):
    // **71 of 73 ticks finish between 270,077 ms and 292,225 ms against this
    // route's 300,000 ms wall** — every normal tick lands in the top decile of its
    // own budget, the worst at **97.4%**. That is by construction: SOFT_DEADLINE_MS
    // is 270,000, so the loop stops with 30 s left and the terminal write plus the
    // in-flight Cadence chunk have to fit in what remains. Measured, that tail has
    // already consumed 22.2 s of the 30. A tick whose tail runs long is killed and
    // writes nothing, and `allday-lock-refresh` sits on
    // `pipeline_cadence_watchlist` at 120 min — so the kill does not merely go
    // unlogged, it is read as "the schedule stopped firing", which needs the
    // opposite response.
    //
    // ⓘ 2026-09-28: those figures describe the 270 s cutoff and the 1,000-id
    // borrowNFT walk. The walk is now IDs-only (a whale in one or a few calls),
    // the cutoff is 200 s and also bounds the walk; `max_wallet_ms` in p_extra
    // is the tail to size against the wall from here on.
    //
    // ⚠ The marker's name carries the `-heartbeat` suffix (added by the helper,
    // never by the caller). A marker under the REAL name would refresh `last_run`
    // every tick and silence `detect_stalled_pipelines()` on exactly the outage it
    // exists to expose.
    await writeInvocationHeartbeat({
      pipeline: PIPELINE_NAME,
      startedAtMs: Date.parse(startedAtIso),
      extra: { wallet_fetch: WALLET_FETCH, soft_deadline_ms: SOFT_DEADLINE_MS },
    })
    try {
      await runBatch(startedAtIso)
    } catch (e) {
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: PIPELINE_NAME,
          p_started_at: startedAtIso,
          p_rows_found: 0,
          p_rows_written: 0,
          p_rows_skipped: 0,
          p_ok: false,
          p_error: `batch crashed: ${e instanceof Error ? e.message : String(e)}`,
          p_extra: { fatal: true },
        })
      } catch {
        /* best-effort */
      }
    }
  })
  return NextResponse.json({ accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

async function runBatch(startedAtIso: string): Promise<void> {
  const started = Date.parse(startedAtIso)

  const { data: wallets, error: walletErr } = await (supabaseAdmin as any).rpc(
    "get_allday_lock_refresh_wallets",
    { p_limit: WALLET_FETCH }
  )
  if (walletErr) {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: 0, p_rows_written: 0, p_rows_skipped: 0,
      p_ok: false, p_error: `wallet fetch: ${String(walletErr.message).slice(0, 300)}`,
      p_extra: { stage: "wallet_fetch" },
    })
    return
  }

  // Stalest-first, so a wallet checked inside REVERIFY_AFTER_MS means every later
  // one was too. A missing/NULL oldest_check is a never-checked row: due.
  const reverifyCutoff = started - REVERIFY_AFTER_MS
  const fetched: Array<{ wallet_address: string; oldest_check?: string | null }> = wallets ?? []
  const candidates = fetched.filter(
    (w) => w.oldest_check == null || Date.parse(w.oldest_check) < reverifyCutoff
  )
  const walletsFresh = fetched.length - candidates.length
  let walletsProcessed = 0
  let walletsDeferred = 0
  let rowsStamped = 0
  let rowsExamined = 0
  let writeErrors = 0
  let marked = 0
  let maxWalletMs = 0
  const errors: Array<{ wallet: string; error: string }> = []

  for (const c of candidates) {
    if (Date.now() - started > SOFT_DEADLINE_MS) break
    const walletStarted = Date.now()
    try {
      const r = await refreshAllDayWalletLocks(c.wallet_address, supabaseAdmin, {
        deadlineMs: started + SOFT_DEADLINE_MS,
      })
      rowsExamined += r.total_cached
      // rows_written counts writes that LANDED, never rows read (2026-09-28).
      rowsStamped += r.rows_stamped
      marked += r.marked_locked + r.marked_unlocked
      if (r.write_errors > 0) {
        writeErrors += r.write_errors
        errors.push({ wallet: c.wallet_address, error: `${r.write_errors} write chunk(s) failed: ${r.first_write_error}` })
      } else {
        walletsProcessed += 1
      }
    } catch (e) {
      if (e instanceof AllDayLockDeadlineError) {
        // Not a failure: the wallet's walk would have crossed the deadline, so
        // nothing was written and it stays stalest for the next tick.
        walletsDeferred += 1
        break
      }
      // Per-wallet failure (e.g. an over-budget whale window) leaves the wallet
      // stale; it is re-selected on a later tick. Not fatal to the batch.
      errors.push({ wallet: c.wallet_address, error: e instanceof Error ? e.message : String(e) })
    } finally {
      maxWalletMs = Math.max(maxWalletMs, Date.now() - walletStarted)
    }
  }

  // ⚠ `ok` means THE BATCH DID ITS JOB, not "every wallet succeeded". From
  // 2026-09-05 05:23Z one wallet (a whale whose Flow script exceeds the
  // execution budget, error 1052) failed on EVERY hourly tick while the same
  // ticks stamped 20,936–33,793 rows each — and because this flag was
  // `errors.length === 0`, the pipeline read 52.5% FAILED for 34 hours with
  // nothing actually wrong. That is the CLAUDE.md "a SWEEP whose ok means it
  // COMPLETED, not that its LANES worked" shape inverted: a sweep whose ok
  // meant one lane worked. The rule there: fail the sweep when a lane fails
  // EVERY target on transport, i.e. when nothing at all was refreshed.
  //
  // So: ok = at least one wallet refreshed, or there was nothing to do. The
  // per-wallet failures are NOT hidden — they stay in `p_error` (first one,
  // verbatim) and `p_extra.errors` / `wallets_failed`, so an observer keying
  // on the failing wallet still sees it, and a wallet that fails forever is
  // visible as a constant `wallets_failed: 1` rather than a red pipeline.
  const attempted = walletsProcessed + errors.length
  const ok = attempted === 0 || walletsProcessed > 0

  await (supabaseAdmin as any).rpc("log_pipeline_run", {
    p_pipeline: PIPELINE_NAME,
    p_started_at: startedAtIso,
    p_rows_found: candidates.length,
    p_rows_written: rowsStamped,
    p_rows_skipped: candidates.length - walletsProcessed,
    p_ok: ok,
    p_error: errors[0] ? `wallet ${errors[0].wallet}: ${errors[0].error}`.slice(0, 300) : null,
    p_extra: {
      duration_ms: Date.now() - started,
      wallets_processed: walletsProcessed,
      wallets_failed: errors.length,
      wallets_deferred: walletsDeferred,
      wallets_candidate: candidates.length,
      wallets_fresh: walletsFresh,
      rows_examined: rowsExamined,
      write_errors: writeErrors,
      max_wallet_ms: maxWalletMs,
      lock_flips: marked,
      errors: errors.slice(0, 5),
    },
  })

  console.log(
    `[allday-lock-refresh] done ok=${ok} wallets=${walletsProcessed}/${candidates.length} failed=${errors.length} stamped=${rowsStamped} flips=${marked} ms=${Date.now() - started}`
  )
}
