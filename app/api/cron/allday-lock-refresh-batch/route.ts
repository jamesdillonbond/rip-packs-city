import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { refreshAllDayWalletLocks } from "@/lib/allday-lock"
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
// There are only ~206 All Day wmc wallets (all seeded/saved), one Cadence diff
// each, so a soft-deadline-bounded set per tick covers the whole population in
// a few hours. Stalest-first ordering means the frozen (never-checked) rows are
// dated on the very first passes.
//
// Bearer INGEST_SECRET_TOKEN or CRON_SECRET. CRON-30S: real work runs in
// after() and returns 202 immediately, matching lock-check-batch.

export const maxDuration = 300
export const dynamic = "force-dynamic"

const PIPELINE_NAME = "allday-lock-refresh"
const WALLET_FETCH = 60 // candidate wallets pulled per tick; the soft deadline caps how many run
const SOFT_DEADLINE_MS = 270_000

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

  const candidates: Array<{ wallet_address: string }> = wallets ?? []
  let walletsProcessed = 0
  let rowsStamped = 0
  let marked = 0
  const errors: Array<{ wallet: string; error: string }> = []

  for (const c of candidates) {
    if (Date.now() - started > SOFT_DEADLINE_MS) break
    try {
      const r = await refreshAllDayWalletLocks(c.wallet_address, supabaseAdmin)
      walletsProcessed += 1
      rowsStamped += r.total_cached
      marked += r.marked_locked + r.marked_unlocked
    } catch (e) {
      // Per-wallet failure (e.g. an over-budget whale window) leaves the wallet
      // stale; it is re-selected on a later tick. Not fatal to the batch.
      errors.push({ wallet: c.wallet_address, error: e instanceof Error ? e.message : String(e) })
    }
  }

  await (supabaseAdmin as any).rpc("log_pipeline_run", {
    p_pipeline: PIPELINE_NAME,
    p_started_at: startedAtIso,
    p_rows_found: candidates.length,
    p_rows_written: rowsStamped,
    p_rows_skipped: candidates.length - walletsProcessed,
    p_ok: errors.length === 0,
    p_error: errors[0] ? `wallet ${errors[0].wallet}: ${errors[0].error}`.slice(0, 300) : null,
    p_extra: {
      duration_ms: Date.now() - started,
      wallets_processed: walletsProcessed,
      wallets_candidate: candidates.length,
      lock_flips: marked,
      errors: errors.slice(0, 5),
    },
  })

  console.log(
    `[allday-lock-refresh] done ok=${errors.length === 0} wallets=${walletsProcessed}/${candidates.length} stamped=${rowsStamped} flips=${marked} ms=${Date.now() - started}`
  )
}
