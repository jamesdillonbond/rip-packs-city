import { NextRequest, NextResponse, after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { isCadenceAddress } from "@/lib/address"

// 800s ceiling (Vercel Pro Lambda hard cap — see the maxDuration note in
// wallet-backfill-multicollection). The orchestrator returns 202 in <5s per
// wallet, so the lambda spends most of this budget PAUSING between dispatch
// batches (see DISPATCH pacing below), not doing CPU work.
export const maxDuration = 800

// ── Dispatch pacing (2026-06-10 DBSAT load-shed) ───────────────────────────
// The prior design capped concurrent /api/wallet-backfill-multicollection
// dispatch fetches at 8, but each dispatch returns 202 immediately, so all
// ~252 active seeded wallets were dispatched within ~30s (verified in
// pipeline_runs: the 12:45 PT wave fired 12:57:54–12:58:26Z). That put ~252
// multicollection orchestrators — each fanning to 5 collection children —
// into their after() phase at the same instant: ~1,260 child lambdas landing
// on the 60-conn Supabase pool at once. The 2026-06-10 12:55Z incident was
// the result: /api/wallet-backfill-allday + -pinnacle threw a 5xx burst
// (210/203 failures in 5 min) and backfill children logged elapsed_ms of
// 580–840s REGARDLESS of wallet size (a 16-moment wallet logged 838s; a 0-
// moment wallet 601s; a 5,208-moment wallet 604s — elapsed_ms uncorrelated
// with on_chain_count). That uniform stall is event-loop + connection-pool
// saturation, not per-wallet work — there is no per-wallet budget loop to
// fix. The lever is to stop firing the whole wave at once.
//
// Fix: dispatch in small batches with a budget-guarded pause between batches
// so orchestrator start times are spread over ~9 minutes instead of ~30s,
// dropping the instantaneous child-arrival rate at the pool ~18x. A hard
// MAX_RUN_MS guard fires the tail immediately if we ever run low on budget,
// so a wallet is never dropped from a cycle (and the orchestrators are
// idempotent — the next 6h cycle re-runs anything missed anyway).
const DISPATCH_BATCH_SIZE = 6
const TARGET_SPREAD_MS = 9 * 60 * 1000 // spread dispatch starts over ~9 min
const MAX_RUN_MS = 720_000 // stop pausing past this; fire the remainder fast
// 🚨 THIS VALUE IS MEASURED-WRONG AND DELIBERATELY NOT FIXED — IT IS BLOCKED ON
// VERCEL SPEND, NOT ON ANALYSIS. Measured 2026-09-13 (PT): at 20_000 the 9-minute
// TARGET_SPREAD_MS above is UNREACHABLE at any real cohort size. Reaching it with
// 20s pauses needs gaps >= 540/20 = 27, i.e. >= 163 tasks in ONE invocation; the
// cohort split (`of: 4`) puts 23-31 there, so 5 gaps x 20s = 100s. Four waves that
// day spread 28/23/29/31 dispatches over 1.4/1.0/1.4/1.7 min, not ~9.
//
// ⭐ So the cohort split — which REDUCED per-run load — destroyed the pacing that
// WAS the load-shed, without touching one line of pacing code.
//
// ⛔ WHY IT STAYS 20_000 FOR NOW: the fix is a one-constant change to 120_000
// (verified green, spread then 6-9 min across the observed range), but it raises
// this route's wall time from ~1.7 min to ~9 min per invocation at 28 invocations/
// day = ~3.4 EXTRA LAMBDA-HOURS/DAY, on the largest maxDuration on the platform.
// On 2026-09-10 a Vercel SPEND-CAP pause took the site and ~20 HTTP lanes down for
// ~10 h, and the cap was raised only slightly afterwards (docs/reference/
// autonomous-tasks.md, #76). That is a Trevor decision, not an autonomous one.
//
// ⚠ The mitigation already in place is the cohort split itself: 28 orchestrators
// over 100s is ~0.28/s against the 2026-06-10 incident's 8.4/s, so the practical
// exposure is ~30x better than the incident even while this constant is wrong.
// Raising it buys a further ~5.4x, which is real but not urgent.
//
// 👉 TO UNBLOCK: set this to 120_000 and flip the two bounds in
// __tests__/seed-wallet-refresh-dispatch-spread.test.ts (they pin TODAY'S broken
// spread on purpose, so this stays measured rather than forgotten).
const MAX_PAUSE_MS = 20_000 // cap any single inter-batch pause

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// Run `tasks` in paced batches: each batch's members fire concurrently
// (Promise.allSettled — one failing task never aborts the wave), then we
// pause before the next batch. Pause is sized so the whole set spreads over
// ~TARGET_SPREAD_MS, capped at MAX_PAUSE_MS, and skipped entirely once we
// cross MAX_RUN_MS so the tail still gets dispatched within the lambda's
// budget.
/**
 * The pacing arithmetic, extracted so the SPREAD it produces can be asserted at a
 * realistic cohort size (see `__tests__/seed-wallet-refresh-dispatch-spread.test.ts`).
 *
 * ⚠ WHY THIS IS A SEPARATE FUNCTION (2026-09-13). The header comment above has
 * promised a ~9-minute spread since 2026-06-10, and for most of that time the code
 * did not deliver one — nothing asserted it, because the pacing lived inline inside
 * an async function that dispatches real HTTP. Measured on 2026-09-13, four cohort
 * waves spread 28/23/29/31 orchestrators over 1.4/1.0/1.4/1.7 min instead of ~9.
 *
 * The cause was arithmetic, not a failure: the cohort split (`of: 4`) cut each
 * invocation to ~28 tasks → 6 batches → 5 gaps → a computed pause of 108s, which the
 * then-20s MAX_PAUSE_MS clamped. Five 20s pauses is the ~100s that was observed. So
 * the change that REDUCED per-run load destroyed the pacing that WAS the load-shed.
 *
 * ⛔ Assert the SPREAD, never the constants — the spread is the property the incident
 * fix is about, and a cohort-count change moves the constants' meaning silently.
 */
export function dispatchPlan(taskCount: number): {
  batches: number
  gaps: number
  pauseMs: number
  spreadMs: number
} {
  const batches = Math.max(1, Math.ceil(taskCount / DISPATCH_BATCH_SIZE))
  const gaps = Math.max(1, batches - 1)
  const pauseMs = Math.min(MAX_PAUSE_MS, Math.floor(TARGET_SPREAD_MS / gaps))
  return { batches, gaps, pauseMs, spreadMs: pauseMs * (batches - 1) }
}

async function dispatchPaced(tasks: Array<() => Promise<void>>): Promise<void> {
  const startMs = Date.now()
  const batches = chunk(tasks, DISPATCH_BATCH_SIZE)
  const { pauseMs } = dispatchPlan(tasks.length)
  for (let b = 0; b < batches.length; b++) {
    await Promise.allSettled(batches[b].map((task) => task()))
    const isLast = b === batches.length - 1
    if (isLast) break
    if (Date.now() - startMs > MAX_RUN_MS) continue // over budget — fire tail fast
    await sleepMs(pauseMs)
  }
}

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

type SeededRow = {
  id: number
  username: string
  wallet_address: string | null
  display_name: string | null
  tags: string[] | null
  priority: number | null
  last_refreshed_at: string | null
  last_refreshed_per_collection: Record<string, string> | null
  cached_moment_count: number | null
}

async function resolveUsernameToAddress(
  username: string
): Promise<string | null> {
  const proxyUrl =
    process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
  try {
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query Resolve($handle: String!) { getUserByFlowHandle(flowHandle: $handle) { flowAddress } }`,
        variables: { handle: username },
      }),
      // 15s cap. `fetch()` has NO default timeout and this runs inside `after()`
      // under maxDuration 800 — the largest budget on the platform, so a single
      // hang here wastes the most compute of any route in this class AND writes
      // no terminal row, leaving the outage indistinguishable from a cron that
      // never fired.
      //
      // ⭐ Not a fresh guess: 15s is the bound already shipped for this SAME
      // Top Shot GraphQL proxy in lib/verify-wallet-gql.ts.
      //
      // ⚠ The caller already try/catches and returns null, so an abort reads as
      // "username did not resolve" — the same outcome as a non-ok response,
      // handled by the existing path rather than a new one.
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as any
    const addr: string | null =
      json?.data?.getUserByFlowHandle?.flowAddress ?? null
    return addr && addr.startsWith("0x") ? addr : null
  } catch {
    return null
  }
}

// Fire wallet-backfill-multicollection so the cron sweep refreshes all 5
// published collections per wallet on every cycle. Each child enricher
// (wallet-backfill, wallet-backfill-allday, …) runs its own after() so
// the orchestrator returns 202 in <5s; most cycles for fully-cached
// wallets are no-ops because skip_cached defaults to true and walks only
// the on-chain → cache diff. Heavy lifting hits whales on first seed.
async function refreshViaWalletBackfill(
  origin: string,
  walletAddress: string,
  ingestToken: string,
  forceFullWalk: boolean
): Promise<boolean> {
  try {
    const res = await fetch(origin + "/api/wallet-backfill-multicollection", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestToken}`,
      },
      body: JSON.stringify({
        wallet: walletAddress,
        // Default-true on the orchestrator side; pass false explicitly when
        // we detect a drift signature (e.g. cached_moment_count sitting on a
        // truncation marker like 24 / 50 / 100).
        skip_cached: !forceFullWalk,
      }),
      // The orchestrator returns 202 immediately; this only guards against a
      // hung dispatch holding a paced slot longer than a batch interval.
      signal: AbortSignal.timeout(15_000),
    })
    return res.status === 202 || res.ok
  } catch {
    return false
  }
}

// Bump last_seen_at on every cache row for a wallet. Used on the no-op path
// when we skip backfill (cache count looks healthy and refresh window has
// not elapsed) so wallet_moments_cache.last_seen_at stays fresh.
async function touchCacheLastSeen(
  supabase: any,
  walletAddress: string
): Promise<number> {
  const now = new Date().toISOString()
  const { error, count } = await supabase
    .from("wallet_moments_cache")
    .update({ last_seen_at: now }, { count: "exact" })
    .eq("wallet_address", walletAddress)
  if (error) {
    console.log(
      `[seed-wallet-refresh] touch last_seen_at failed for ${walletAddress}: ${error.message}`
    )
    return 0
  }
  return count ?? 0
}

// Cache counts at known truncation signatures (24 = wallet-search default
// limit, 50 / 60 = manual-limit pages, 100 / 101 = older paginated paths).
// Force a full backfill walk for any wallet sitting on one of these so the
// fix re-enriches the entire collection on first run.
const SUSPICIOUS_COUNTS = new Set<number>([24, 25, 48, 50, 60, 96, 100, 101, 200])

// ── Low-priority interval widening (VERCEL-FLUID-RIGHTSIZE, 2026-06-14) ─────
// The 6h wave re-walked EVERY active seeded wallet on every cycle. ~76% of the
// herd is the discovered cohort — priority 4/5 rows tagged
// discovered_active_trader / active_flipper / real_collector, no username, no
// logged-in user waiting on them; they feed analytics/discovery boards that
// tolerate daily-ish staleness. Refreshing them 4×/day is the dominant Fluid
// GB-hr cost (see docs/handoff-2026-06-13-vercel-cost-plan.md Item 2). We now
// SKIP a low-priority wallet on a wave when its last actual walk
// (seeded_wallets.last_refreshed_at, stamped by the TopShot child's
// refresh_seeded_wallet_stats) is fresher than LOW_PRIORITY_INTERVAL. High-
// priority wallets (priority <= LOW_PRIORITY_MIN-1, or NULL) always refresh.
// Because the gate is age-based and every wave is eligible to pick a wallet up,
// effective cadence is the interval rounded up to the next 6h wave (~24h at the
// default). A wallet that's never been walked (last_refreshed_at NULL) or sits
// on a truncation signature (forceFull) bypasses the gate so first-seed and
// repair still happen immediately. Both knobs are env-tunable so the operator
// can dial back toward 6h instantly (no redeploy) if a wave ever runs heavy:
//   SEED_REFRESH_LOWPRI_MIN            (default 4)  — min priority # = "low"
//   SEED_REFRESH_LOWPRI_INTERVAL_HOURS (default 24) — 0 disables the gate
// NaN/garbage env → gate degrades to a no-op (current 6h-for-all behavior).
const LOW_PRIORITY_MIN = Number(process.env.SEED_REFRESH_LOWPRI_MIN ?? 4)
const LOW_PRIORITY_INTERVAL_HOURS = Number(
  process.env.SEED_REFRESH_LOWPRI_INTERVAL_HOURS ?? 24
)
const LOW_PRIORITY_INTERVAL_MS =
  Math.max(0, LOW_PRIORITY_INTERVAL_HOURS) * 60 * 60 * 1000

// ── THE WAVE CADENCE, IN ONE PLACE (2026-09-13) ──────────────────────────
// How often a primary wave actually runs, in hours. Used by BOTH the cadence
// gate that decides whether a wave executes at all AND the backstop freshness
// window below. ⚠ THEY ARE THE SAME FACT AND THEY MUST NOT BE TWO LITERALS:
// the cadence moved 6h -> 12h on 2026-07-18 and the backstop window did not
// follow, which left the backstop guard skipping ZERO for six weeks (measured
// 2026-09-13 — see the block below). Change this one constant and both move.
const WAVE_CADENCE_HOURS = 12

// ── Backstop freshness gate (2026-08-30) ─────────────────────────────────
// A FORCED wave is the GHA backstop (wallet-backfill-backstop.yml, ?force=1),
// whose one job is to refresh wallets a primary cohort MISSED. It used to
// re-dispatch every high-priority wallet regardless — and because GitHub does
// not honour the `38 2,8,14,20` schedule (median +45 min, p90 +205 min), the
// 08:38Z run landed at 13:58Z on 2026-08-30, right after the 12/13Z primary
// wave had finished all four cohorts with errors=0: 120 wallets re-dispatched,
// ~600 collection walks, every one a no-op that still paid the full
// wallet_moments_cache read + backfill_wmc_metadata_from_editions against a
// disk already at 33/36 backends in DataFileRead. So on a forced wave, skip
// any wallet whose last walk is younger than BACKSTOP_FRESH_HOURS — using the
// per-collection stamp (written unconditionally on every child run) rather
// than last_refreshed_at (stamped only when rows changed or stats aged past
// 6h). Never-seeded / truncation-signature wallets still bypass. Primaries
// (unforced waves) are untouched. 0 disables.
// 🚨 THE 3-HOUR DEFAULT WAS SIZED FOR ONE LANDING AND MISSED EVERY OTHER ONE —
// MEASURED 2026-09-13, AND THE GUARD WAS SKIPPING **ZERO**.
// The motivating incident above is a backstop landing RIGHT AFTER a primary
// (13:58Z against a 12/13Z wave, ~1 h old), which 3 h catches. But the waves run
// on a 12 h cadence at hours 0/1 and 12/13, and the drift measured in that same
// comment (median +45 min, p90 +205 min) puts a landing anywhere in the 10 hours
// AFTER a primary — where the wallets are 4–11 h old and 3 h catches nothing.
// Live over 24 h: every forced wave reported `backstop_fresh_skipped = 0` with
// `backfill_fired == processed` (39/39, 37/37, 33/33, 47/47), while the
// neighbouring low-priority gate skipped 17–36 per wave, so the mechanism works
// and only the NUMBER was wrong. Three drifted backstop sweeps (hours 07, 17, 22)
// fired **403** wallet-backfill runs against **303** from the four sanctioned
// waves — i.e. the backstop had become the LARGER consumer of the platform's
// single largest compute consumer, and the 2026-07-18 cost lever above was
// substantially unrealised.
//
// ⭐ THE WINDOW IS NOW THE CADENCE ITSELF, because they are the same fact: the
// question this gate asks is "did the most recent primary already refresh this
// wallet?", and a primary runs every WAVE_CADENCE_HOURS. Anything younger than
// one cadence was covered by a primary that SUCCEEDED; anything older was missed
// by one that did not — which is exactly when the backstop should fire. That
// keeps the redundancy this bypass exists for (cron-job.org trigger dropout)
// fully intact, and it is why the two constants are now coupled in code rather
// than being two literals that drifted apart for six weeks.
//   SEED_REFRESH_BACKSTOP_FRESH_HOURS (default WAVE_CADENCE_HOURS = 12)
const BACKSTOP_FRESH_HOURS = Number(
  process.env.SEED_REFRESH_BACKSTOP_FRESH_HOURS ?? WAVE_CADENCE_HOURS
)
const BACKSTOP_FRESH_MS =
  (Number.isFinite(BACKSTOP_FRESH_HOURS) ? Math.max(0, BACKSTOP_FRESH_HOURS) : WAVE_CADENCE_HOURS) *
  60 *
  60 *
  1000

// Most recent walk of any collection for this wallet, as epoch ms; NaN when
// the wallet has never been walked (or the stamps are unparseable).
function lastWalkMs(row: {
  last_refreshed_at: string | null
  last_refreshed_per_collection: Record<string, string> | null
}): number {
  let best = NaN
  const consider = (raw: unknown) => {
    if (typeof raw !== "string") return
    const t = Date.parse(raw)
    if (Number.isFinite(t) && (!Number.isFinite(best) || t > best)) best = t
  }
  consider(row.last_refreshed_at)
  const per = row.last_refreshed_per_collection
  if (per && typeof per === "object") for (const v of Object.values(per)) consider(v)
  return best
}

function isLowPriority(priority: number | null): boolean {
  return priority != null && priority >= LOW_PRIORITY_MIN
}

// ── Saved-wallet ownership sweep (2026-09-20) ────────────────────────────────
// 🚨 THE POPULATION THIS ROUTE SWEEPS WAS THE WRONG SET, AND IT WAS A
// USER-FACING FALSE CLAIM, NOT A FRESHNESS NICETY.
//
// `wallet_moments_cache` is re-verified only by a wallet re-scan, and a re-scan
// happens only when something dispatches /api/wallet-backfill-multicollection.
// Every recurring dispatcher is this route, and every cohort above is selected
// from `seeded_wallets` — so a wallet a real user SAVED was re-verified only if
// it also happened to be a seeded demo/benchmark wallet. A departed moment is
// pruned by `deleteUnseenWmcRows` on every walk (skip_cached skips re-WRITING a
// cached id, never the on-chain enumeration), so the cache is correct exactly as
// often as the wallet is walked — and never walked means a portfolio that still
// lists moments the wallet sold, with no staleness disclosed.
//
// MEASURED 2026-09-20 (PT), all 27 saved wallets, 135 (wallet, collection) pairs:
//   saved AND seeded  -> 22 wallets / 110 pairs, last_scanned_at 0.18-0.71 days
//   saved, NOT seeded ->  5 wallets /  25 pairs, last_scanned_at 5.86-42.87 days
// The ranges do not overlap and 5x5 is exactly the stale set, so membership of
// `seeded_wallets` FULLY determined whether a user's moments were re-verified.
// `check_wmc_ownership_freshness()` (7-day threshold, counts only pairs that
// actually hold cached rows) flagged 5 rows / 4 wallets from that group.
//
// ⚠ IT IS NOT "19% OF USERS" IN STEADY STATE. 22 of 27 are seeded only because
// `lib/allow-list/prewarm.ts` INSERTS an early-access signup into seeded_wallets
// as a side effect. A wallet that reaches `saved_wallets` by any other path — the
// ordinary in-app save — is never seeded and therefore never re-verified, so the
// unswept share grows with every non-allow-list user. Keying on the seeded table
// was never a capacity ceiling; no amount of capacity fixes the wrong set.
//
// ── WHY THIS SHAPE, AND WHAT IT COSTS ───────────────────────────────────────
// The marginal cost is |saved \ active-seeded| ONLY — a saved wallet that is also
// seeded is already walked by its own cohort and is excluded here, so it is never
// dispatched twice. Today that marginal set is 5 wallets x 5 collections.
//
// Two independent knobs, because they bound two different things:
//   * STALE_HOURS bounds the STEADY-STATE rate. A wallet is a candidate only once
//     its newest walk ages past the threshold, so each swept wallet costs 5 walks
//     per threshold period regardless of how many waves observe it. At 5 wallets
//     and 24h that is ~25 walks/day against the ~2,540/day the seeded herd
//     already runs (254 active x 5 x 2 waves) — about +1%.
//   * MAX_PER_WAVE bounds the BURST. It cannot raise the steady-state rate; it
//     only caps how much of a backlog one invocation may drain, so an import of
//     500 users degrades into a slower catch-up instead of an on-chain stampede.
// ⚠ Judge them separately — reading the cap as the cost is the mistake that makes
// this look like an open-ended spend commitment when it is a bounded +1%.
//
// Cohort assignment is by a stable hash of the ADDRESS, mirroring the
// `seeded_wallets.id % N` split above: a saved-only wallet belongs to exactly one
// cohort, so the four cron entries cannot each dispatch the same wallet before any
// of them has stamped `last_scanned_at` (the walks are async — a shared candidate
// list would fan out 4x, not 1x).
//
// REVERT WITHOUT A DEPLOY: set SEED_REFRESH_SAVED_STALE_HOURS=0. The sweep then
// selects nothing and this route is byte-identical to its pre-2026-09-20 behaviour.
//   SEED_REFRESH_SAVED_STALE_HOURS  (default 24) — 0 disables the sweep entirely
//   SEED_REFRESH_SAVED_MAX_PER_WAVE (default 10) — burst cap per invocation
const SAVED_SWEEP_STALE_HOURS = Number(
  process.env.SEED_REFRESH_SAVED_STALE_HOURS ?? 24
)
const SAVED_SWEEP_STALE_MS =
  (Number.isFinite(SAVED_SWEEP_STALE_HOURS) ? Math.max(0, SAVED_SWEEP_STALE_HOURS) : 24) *
  60 *
  60 *
  1000
const SAVED_SWEEP_MAX_PER_WAVE = Number(
  process.env.SEED_REFRESH_SAVED_MAX_PER_WAVE ?? 10
)

/**
 * Stable 32-bit FNV-1a over the address, used to assign a saved-only wallet to
 * exactly one cohort.
 *
 * ⛔ IT MUST NOT BE `Math.random`, a row id, or anything that moves between
 * invocations: the four cron cohorts run in separate lambdas minutes apart and
 * never see each other's picks, so the ONLY thing preventing a 4x fan-out of the
 * same wallet is that all four compute the same bucket from the same string.
 */
export function cohortOfAddress(address: string, cohortN: number): number {
  if (!Number.isInteger(cohortN) || cohortN <= 1) return 0
  let h = 0x811c9dc5
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % cohortN
}

export type SavedSweepCandidate = {
  wallet: string
  /** Newest `wallet_backfill_state.last_scanned_at` in ms; NaN when never scanned. */
  lastScannedAtMs: number
}

export type SavedSweepPlan = {
  picked: SavedSweepCandidate[]
  freshSkipped: number
  cappedOut: number
  nonCadenceSkipped: number
}

/**
 * Decide which saved-only wallets this invocation re-verifies.
 *
 * Extracted as a pure function for the same reason `dispatchPlan` above is: the
 * property that matters is the SELECTION, and selection that lives inline inside
 * an `after()` that dispatches real HTTP is asserted by nothing. The route test
 * stubs `after()`, so anything left in there is literally unreachable from a test.
 *
 * ⚠ `staleMs <= 0` disables the sweep and returns an EMPTY plan with zero
 * counters — that is the operator kill switch, and a caller must report it as
 * "disabled", never as "nothing was stale".
 *
 * ⛔ The chain gate is `isCadenceAddress`, not `startsWith("0x")`. This route
 * fans out to the five PUBLISHED FLOW collections, so a Candy (base58) or EVM
 * (40-hex) saved wallet has nothing for it to walk — but it is EXCLUDED and
 * COUNTED, never silently dropped, because "this sweep does not cover that chain"
 * and "that wallet is fresh" are different facts and only one of them is true.
 */
export function planSavedWalletSweep(opts: {
  candidates: SavedSweepCandidate[]
  nowMs: number
  staleMs: number
  maxPerWave: number
}): SavedSweepPlan {
  const { candidates, nowMs, staleMs, maxPerWave } = opts
  if (!(staleMs > 0)) {
    return { picked: [], freshSkipped: 0, cappedOut: 0, nonCadenceSkipped: 0 }
  }

  let freshSkipped = 0
  let nonCadenceSkipped = 0
  const stale: SavedSweepCandidate[] = []

  for (const candidate of candidates) {
    if (!isCadenceAddress(candidate.wallet)) {
      nonCadenceSkipped++
      continue
    }
    const scanned = candidate.lastScannedAtMs
    // A NEVER-SCANNED wallet (NaN) is the most stale thing there is, not a
    // freshness unknown to be skipped — it falls through to `stale` on purpose.
    if (Number.isFinite(scanned) && nowMs - scanned >= 0 && nowMs - scanned < staleMs) {
      freshSkipped++
      continue
    }
    stale.push(candidate)
  }

  // Oldest first, never-scanned ahead of everything, address as the tiebreak so
  // the order is total and a capped wave is reproducible rather than arbitrary.
  stale.sort((a, b) => {
    const av = Number.isFinite(a.lastScannedAtMs) ? a.lastScannedAtMs : -Infinity
    const bv = Number.isFinite(b.lastScannedAtMs) ? b.lastScannedAtMs : -Infinity
    if (av !== bv) return av - bv
    return a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0
  })

  const cap = Number.isFinite(maxPerWave) ? Math.max(0, Math.floor(maxPerWave)) : 0
  const picked = stale.slice(0, cap)
  return {
    picked,
    freshSkipped,
    cappedOut: stale.length - picked.length,
    nonCadenceSkipped,
  }
}

type SavedSweepLoad = {
  candidates: SavedSweepCandidate[]
  /** Non-null when a read FAILED. A caller must not publish counts alongside it. */
  error: string | null
  /** True when a read hit its page ceiling, so the candidate set is PARTIAL. */
  truncated: boolean
}

// PostgREST caps a read at 1000 rows and CLAMPS an explicit larger `.limit()`,
// so 1000 is the real page size, not a number we chose.
const PAGE_CAP = 1000

/**
 * Load this cohort's saved-but-not-actively-seeded wallets with the newest
 * ownership-verification stamp each one carries.
 *
 * ⚠ `last_scanned_at` is the right column and `wallet_moments_cache.last_seen_at`
 * is not: the latter is a content-change watermark that decays while ownership is
 * still being re-verified. `check_wmc_ownership_freshness()` reads the same
 * column, which is what makes the "Done looks like" check and this selector agree
 * instead of measuring two different things.
 *
 * ⛔ A FAILED READ IS REPORTED, NEVER RENDERED AS AN EMPTY SWEEP. Both exits
 * return `error` set and an empty candidate list, and the caller logs the error
 * beside a NULL count — "the sweep found nothing stale" and "the sweep could not
 * look" are the two states this repo keeps confusing, and an empty list is the
 * honest shape for neither.
 */
export async function loadSavedOnlyCandidates(
  supabase: any,
  seededActive: Set<string>,
  cohortK: number,
  cohortN: number
): Promise<SavedSweepLoad> {
  // Keyset walk over DISTINCT wallet_addr values. `wallet_addr` is not unique in
  // saved_wallets (135 rows / 27 wallets on 2026-09-20 — one row per collection),
  // and that is fine here precisely BECAUSE we want distinct values: `.gt(cursor)`
  // steps past the rest of a duplicate group whose value we already captured.
  const addresses: string[] = []
  let cursor: string | null = null
  let truncated = true
  for (let page = 0; page < 10; page++) {
    let q = supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .not("wallet_addr", "is", null)
      .order("wallet_addr", { ascending: true })
      .limit(PAGE_CAP)
    if (cursor) q = q.gt("wallet_addr", cursor)
    const { data, error } = await q
    if (error) {
      return { candidates: [], error: `saved_wallets: ${error.message}`, truncated: false }
    }
    const rows = (data ?? []) as Array<{ wallet_addr: string | null }>
    for (const row of rows) if (row.wallet_addr) addresses.push(row.wallet_addr)
    if (rows.length < PAGE_CAP) {
      truncated = false
      break
    }
    cursor = rows[rows.length - 1]?.wallet_addr ?? null
    if (!cursor) {
      truncated = false
      break
    }
  }

  // Exclude wallets an ACTIVE seeded row already covers — those are walked by
  // their own cohort above, and dispatching them here would double the work
  // rather than add any freshness. An INACTIVE seeded row is not a sweeper, so a
  // wallet that only appears there correctly stays a candidate.
  const mine = Array.from(new Set(addresses))
    .filter((w) => !seededActive.has(w))
    .filter((w) => cohortOfAddress(w, cohortN) === cohortK)

  if (mine.length === 0) return { candidates: [], error: null, truncated }

  // Chunked so no single `.in()` can reach the 1000-row clamp: 100 wallets x at
  // most a handful of collections each stays well inside one page.
  const newest = new Map<string, number>()
  for (const batch of chunk(mine, 100)) {
    const { data, error } = await supabase
      .from("wallet_backfill_state")
      .select("wallet_address,last_scanned_at")
      .in("wallet_address", batch)
      .limit(PAGE_CAP)
    if (error) {
      return {
        candidates: [],
        error: `wallet_backfill_state: ${error.message}`,
        truncated,
      }
    }
    const rows = (data ?? []) as Array<{
      wallet_address: string
      last_scanned_at: string | null
    }>
    if (rows.length >= PAGE_CAP) truncated = true
    for (const row of rows) {
      const t = row.last_scanned_at ? Date.parse(row.last_scanned_at) : NaN
      if (!Number.isFinite(t)) continue
      const prev = newest.get(row.wallet_address)
      if (prev === undefined || t > prev) newest.set(row.wallet_address, t)
    }
  }

  return {
    candidates: mine.map((wallet) => ({
      wallet,
      lastScannedAtMs: newest.get(wallet) ?? NaN,
    })),
    error: null,
    truncated,
  }
}

export async function GET(req: NextRequest) {
  // Support both ?token= query param and Authorization: Bearer header
  const queryToken = req.nextUrl.searchParams.get("token")
  const authHeader = req.headers.get("authorization") ?? ""
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null
  const token = queryToken || bearerToken

  if (!token || token !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  // ── Cohort split (2026-06-12 DBSAT-IO-EXHAUSTION-0612 mitigation 3b) ───────
  // Optional ?cohort=K&of=N splits the active herd into N disjoint cohorts by
  // (seeded_wallets.id % N === K) so the 6h wave can be fired as N staggered
  // cron entries (~15 min apart), spreading the same backfill work over
  // ~45-54 min WITHOUT widening the in-lambda pacing (bounded by maxDuration's
  // 800s hard cap, so a single lambda can't spread past ~13 min). Absent
  // params → single full wave, byte-identical to the pre-cohort path.
  const ofParam = req.nextUrl.searchParams.get("of")
  const cohortParam = req.nextUrl.searchParams.get("cohort")
  const cohortN = ofParam == null ? 1 : Number(ofParam)
  const cohortK = cohortParam == null ? 0 : Number(cohortParam)
  if (
    !Number.isInteger(cohortN) ||
    !Number.isInteger(cohortK) ||
    cohortN < 1 ||
    cohortN > 8 ||
    cohortK < 0 ||
    cohortK >= cohortN
  ) {
    return NextResponse.json(
      {
        error:
          "invalid cohort params: require integer 1<=of<=8 and 0<=cohort<of",
      },
      { status: 400 }
    )
  }

  // ── 12h cadence gate (2026-07-18 Phase 2 cost lever) ──────────────────────
  // The wallet-backfill fan-out is the platform's single largest compute
  // consumer: measured over 7d, the 7 wallet-backfill* pipelines burn ~113
  // lambda-hours/day (multicollection-complete alone ~49h at 262s x 680 runs)
  // and every one of those lambdas lands on the same 60-conn Supabase pool —
  // so it is simultaneously the #1 Vercel Fluid-memory driver AND the #1
  // DB-IOPS driver behind the recurring statement-timeout/contention class.
  //
  // Halving the wave cadence 6h -> 12h removes ~56 lambda-hours/day at the
  // cost of ~2x wallet-data staleness. That trade is strongly favourable at
  // current traction (31 sessions/7d), and the orchestrators are idempotent,
  // so a skipped wave costs nothing but freshness.
  //
  // Implemented here rather than in the cron console so the change is
  // version-controlled and revertible with `git revert`. The 4 cron-job.org
  // cohort entries still FIRE 4x/day (hours 0,6,12,18 for cohorts 0-1 and
  // 1,7,13,19 for cohorts 2-3); this gate executes only the 0/1 and 12/13
  // waves and no-ops the rest in <1s. hour % 12 < 2 covers every cohort's
  // slot without needing to know which cohort is calling.
  //
  // PERMANENT FORM: set the 4 cron entries to `45 */12`, `59 */12`,
  // `13 1,13`, `27 1,13` and delete this gate — then the schedule lives in
  // one place again. Until then docs/operations/cron-schedule.md carries the
  // note. Set SEED_WALLET_REFRESH_EVERY_WAVE=1 to disable the gate without a
  // deploy.
  //
  // ?force=1 BYPASS (added same day, after the daytime monitor caught the
  // regression): the GHA wallet-backfill backstop
  // (.github/workflows/wallet-backfill-backstop.yml, `38 2,8,14,20 * * *`)
  // calls THIS route, and 2,8,14,20 all satisfy hour%12>=2 — so the first
  // cut of this gate silently no-op'd every backstop invocation, killing the
  // only redundancy for cron-job.org trigger dropout (the platform's
  // documented recurring failure class). The backstop must therefore be able
  // to opt out. Measured cost of letting it through: hours 2/8/20 produced
  // ZERO wallet-backfill runs over 3 days and hour 14 produced 14 (~5/day),
  // vs ~1,213/day for the waves this gate drops — the backstop only does
  // real work when a primary cohort actually failed, so the bypass is
  // effectively free. Safe to expose as a query param because the route is
  // already auth-gated (Bearer INGEST_SECRET_TOKEN / CRON_SECRET) above.
  const forceWave = ["1", "true"].includes(
    (req.nextUrl.searchParams.get("force") ?? "").toLowerCase()
  )
  const utcHour = new Date().getUTCHours()
  const gateSkips =
    !forceWave &&
    process.env.SEED_WALLET_REFRESH_EVERY_WAVE !== "1" &&
    utcHour % WAVE_CADENCE_HOURS >= 2

  // ── Invocation record, BOTH branches (2026-08-28) ─────────────────────────
  // ⚠ Until this landed the gate above `return`ed before ANY pipeline_runs
  // write, so a gated invocation and a dead cron were byte-identical in the
  // telemetry: measured 2026-08-28, ZERO of 11,012 wallet-backfill* rows over
  // 72h carried any skip record. The observable consequence was that the six
  // `wallet-backfill*` cadence arms sat at max_silent_minutes=420 against a
  // measured max inter-run gap of 677 min — arms that CANNOT be green, on the
  // top severity band, which is how a genuinely missed wave gets skipped past.
  //
  // ⚠ WHY THE **REAL** NAME AND NOT `-heartbeat`. lib/pipeline/heartbeat.ts
  // warns that a marker under the real name refreshes `last_run` and silences
  // `detect_stalled_pipelines()`. That warning is about an INCOMPLETE run — a
  // heartbeat written before `after()` work that may still be killed. This row
  // is different in kind: for the gated branch the invocation is COMPLETE and
  // its entire job was to decline, so a terminal row is the honest shape and
  // refreshing `last_run` is the correct outcome. Silencing is exactly what we
  // want here and only here: this route is the only component in the family
  // with a ~6h heartbeat (cron-job.org cohorts at hours 0,1,6,7,12,13,18,19),
  // so it is the right layer to watch for trigger dropout. The CHILD pipelines
  // keep their own separate arms at their true 12h design cadence, and this row
  // does not touch them — a killed `after()` wave still shows up there.
  //
  // ⚠ rows_* are NULL, never 0: this row measures nothing, and a 0 here is the
  // fabricated-measurement shape this repo bans. `finished_at` is pinned to
  // `started_at` so `duration_ms` (GENERATED) reads a hard 0 sentinel rather
  // than publishing this INSERT's own latency as a run duration.
  //
  // Never fatal: a failed telemetry write must not take down the wave.
  const invocationStartedAt = new Date().toISOString()

  // `finishedAt` defaults to the invocation start, making `duration_ms`
  // (GENERATED from the pair) a hard 0 sentinel rather than publishing this
  // INSERT's own latency as a run duration. The wave's terminal row passes a
  // REAL finish time, because there a duration is a measurement someone took.
  async function logInvocationRow(
    pipeline: string,
    extra: Record<string, unknown>,
    finishedAt: string = invocationStartedAt
  ): Promise<void> {
    try {
      const { error: logErr } = await getSupabase()
        .from("pipeline_runs")
        .insert({
          pipeline,
          started_at: invocationStartedAt,
          finished_at: finishedAt,
          ok: true,
          rows_found: null,
          rows_written: null,
          rows_skipped: null,
          extra: { utcHour, cohort: cohortK, of: cohortN, forced: forceWave, ...extra },
        })
      if (logErr) {
        console.warn(
          `[seed-wallet-refresh] ${pipeline} log failed: ${logErr.code ?? "?"}: ${logErr.message ?? String(logErr)}`
        )
      }
    } catch (thrown) {
      console.warn(
        `[seed-wallet-refresh] ${pipeline} log threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`
      )
    }
  }

  if (gateSkips) {
    // A COMPLETE run whose entire job was to decline. Terminal row under the
    // real name, so it refreshes `last_run` — which is the intended outcome
    // here and nowhere else in this route.
    await logInvocationRow("seed-wallet-refresh", { reason: "12h_cadence_gate" })
    console.log(
      `[seed-wallet-refresh] skipped — 12h cadence gate (utcHour=${utcHour}, cohort=${cohortK}/${cohortN})`
    )
    return NextResponse.json({
      status: "skipped",
      reason: "12h_cadence_gate",
      utcHour,
      cohort: cohortK,
      of: cohortN,
    })
  }

  const origin = new URL(req.url).origin
  const ingestToken = process.env.INGEST_SECRET_TOKEN!

  // ⚠ The wave path is a `after()` route, so a `maxDuration` kill takes the
  // terminal row with it and `try/catch` cannot see it. The marker written
  // BEFORE the work is the only evidence — a heartbeat with no terminal row
  // sharing its `started_at` is a kill; neither row is a cron that never fired.
  // Separate `-heartbeat` name deliberately: under the real name it would
  // refresh `last_run` and silence the very alert it exists to raise. The
  // suffix and the row shape come from the shared helper, never hand-rolled.
  await writeInvocationHeartbeat(
    {
      pipeline: "seed-wallet-refresh",
      startedAtMs: Date.parse(invocationStartedAt),
      extra: {
        reason: "wave_dispatch",
        utcHour,
        cohort: cohortK,
        of: cohortN,
        forced: forceWave,
      },
    },
    getSupabase()
  )

  after(async () => {
    const supabase = getSupabase()

    const { data, error } = await supabase
      .from("seeded_wallets")
      .select("id, username, wallet_address, display_name, tags, priority, last_refreshed_at, last_refreshed_per_collection, cached_moment_count")
      .eq("is_active", true)

    if (error) {
      console.log(`[seed-wallet-refresh] fetch error: ${error.message}`)
      return
    }

    const rows = (data as SeededRow[] | null) ?? []
    // When split into cohorts, keep only this cohort's slice by id-modulo.
    const cohortRows =
      cohortN > 1 ? rows.filter((r) => r.id % cohortN === cohortK) : rows

    // Low-priority interval gate: drop discovered-herd wallets that were walked
    // more recently than LOW_PRIORITY_INTERVAL_MS. forceFull (never-seeded or
    // truncation-signature) and high-priority wallets are never gated.
    const nowMs = Date.now()
    let lowPrioritySkipped = 0
    let backstopFreshSkipped = 0
    const addressRows = cohortRows
      .filter((r) => r.wallet_address != null)
      .filter((row) => {
        const cached = row.cached_moment_count ?? 0
        const forceFull = cached === 0 || SUSPICIOUS_COUNTS.has(cached)
        if (forceWave && !forceFull && BACKSTOP_FRESH_MS > 0) {
          const ageMs = nowMs - lastWalkMs(row)
          if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < BACKSTOP_FRESH_MS) {
            backstopFreshSkipped++
            return false
          }
        }
        if (
          !forceFull &&
          LOW_PRIORITY_INTERVAL_MS > 0 &&
          isLowPriority(row.priority) &&
          row.last_refreshed_at
        ) {
          const ageMs = nowMs - new Date(row.last_refreshed_at).getTime()
          if (ageMs >= 0 && ageMs < LOW_PRIORITY_INTERVAL_MS) {
            lowPrioritySkipped++
            return false
          }
        }
        return true
      })
    const walletsWithAddress = addressRows
    const walletsWithoutAddress = cohortRows.filter(
      (r) => r.wallet_address == null
    )

    const errors: string[] = []
    let backfillFired = 0
    let backfillForced = 0
    let usernameResolved = 0
    let resolutionFailed = 0

    // Build one flat task list and run it through the paced batch runner so
    // BOTH groups (known-address and username-only) share a single spread
    // window. Address wallets go first (the bulk); username wallets resolve
    // then force a full walk. Counters are mutated in-place — safe under
    // single-threaded JS even with concurrent in-batch tasks.
    const tasks: Array<() => Promise<void>> = []

    for (const row of walletsWithAddress) {
      tasks.push(async () => {
        try {
          const addr = row.wallet_address!
          const cached = row.cached_moment_count ?? 0
          const forceFull = cached === 0 || SUSPICIOUS_COUNTS.has(cached)
          const ok = await refreshViaWalletBackfill(origin, addr, ingestToken, forceFull)
          if (ok) {
            backfillFired++
            if (forceFull) backfillForced++
            console.log(
              `[seed-wallet-refresh] backfill-fired ${row.username} (${addr}) cached=${cached} force_full=${forceFull}`
            )
          } else {
            errors.push(`backfill failed for ${row.username}`)
            console.log(
              `[seed-wallet-refresh] backfill failed for ${row.username} (${addr})`
            )
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${row.username}: ${msg}`)
          console.log(`[seed-wallet-refresh] error for ${row.username}: ${msg}`)
        }
      })
    }

    // ── Saved-wallet ownership sweep ─────────────────────────────────────
    // Appended to the SAME task list, so these ride the existing paced
    // dispatcher rather than arriving as an unpaced burst beside it.
    const seededActive = new Set(
      rows.map((r) => r.wallet_address).filter((w): w is string => !!w)
    )
    const savedLoad = await loadSavedOnlyCandidates(
      supabase,
      seededActive,
      cohortK,
      cohortN
    )
    const savedPlan = planSavedWalletSweep({
      candidates: savedLoad.candidates,
      nowMs,
      staleMs: SAVED_SWEEP_STALE_MS,
      maxPerWave: SAVED_SWEEP_MAX_PER_WAVE,
    })
    let savedFired = 0
    for (const candidate of savedPlan.picked) {
      tasks.push(async () => {
        try {
          // skip_cached=true is the CORRECT mode for a re-verification pass and
          // not a cheaper approximation of one: the child always enumerates the
          // full on-chain id set and always runs deleteUnseenWmcRows, so a
          // departed moment is pruned either way. skip_cached only suppresses
          // re-WRITING an id already in the cache. A full walk here would pay
          // the entire upsert cost to reach the same holdings.
          const ok = await refreshViaWalletBackfill(
            origin,
            candidate.wallet,
            ingestToken,
            false
          )
          if (ok) {
            savedFired++
            console.log(
              `[seed-wallet-refresh] saved-sweep fired ${candidate.wallet} last_scanned=${
                Number.isFinite(candidate.lastScannedAtMs)
                  ? new Date(candidate.lastScannedAtMs).toISOString()
                  : "never"
              }`
            )
          } else {
            errors.push(`saved-sweep backfill failed for ${candidate.wallet}`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`saved-sweep ${candidate.wallet}: ${msg}`)
        }
      })
    }

    for (const row of walletsWithoutAddress) {
      tasks.push(async () => {
        try {
          const resolved = await resolveUsernameToAddress(row.username)
          if (!resolved) {
            resolutionFailed++
            console.log(
              `[seed-wallet-refresh] username resolution failed for ${row.username}`
            )
            return
          }

          await supabase
            .from("seeded_wallets")
            .update({ wallet_address: resolved })
            .eq("id", row.id)

          usernameResolved++
          console.log(
            `[seed-wallet-refresh] resolved ${row.username} → ${resolved}`
          )

          const ok = await refreshViaWalletBackfill(origin, resolved, ingestToken, true)
          if (ok) {
            backfillFired++
            backfillForced++
          } else {
            errors.push(`backfill failed for ${row.username} (resolved)`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${row.username}: ${msg}`)
          console.log(
            `[seed-wallet-refresh] error resolving ${row.username}: ${msg}`
          )
        }
      })
    }

    await dispatchPaced(tasks)

    // ⛔ COUNTS ONLY WHERE A COUNT WAS ACTUALLY TAKEN. When the sweep is disabled
    // or its read failed, every candidate/fresh/capped field is NULL and the state
    // says which — a 0 here would be the fabricated-measurement shape this repo
    // bans, and "disabled", "could not read" and "nothing was stale" are three
    // different facts that a single 0 renders identically.
    const savedSweepState = savedLoad.error
      ? "read_failed"
      : SAVED_SWEEP_STALE_MS <= 0
        ? "disabled"
        : "ok"
    const savedSweepMeasured = savedSweepState === "ok"
    const savedSweepExtra = {
      saved_sweep_state: savedSweepState,
      saved_sweep_error: savedLoad.error,
      saved_sweep_truncated: savedLoad.error ? null : savedLoad.truncated,
      saved_sweep_stale_hours: SAVED_SWEEP_STALE_HOURS,
      saved_sweep_max_per_wave: SAVED_SWEEP_MAX_PER_WAVE,
      saved_sweep_candidates: savedSweepMeasured ? savedLoad.candidates.length : null,
      saved_sweep_picked: savedSweepMeasured ? savedPlan.picked.length : null,
      saved_sweep_fired: savedSweepMeasured ? savedFired : null,
      saved_sweep_fresh_skipped: savedSweepMeasured ? savedPlan.freshSkipped : null,
      saved_sweep_capped_out: savedSweepMeasured ? savedPlan.cappedOut : null,
      saved_sweep_non_cadence: savedSweepMeasured ? savedPlan.nonCadenceSkipped : null,
    }

    console.log(
      `[seed-wallet-refresh] saved-sweep state=${savedSweepState}` +
        (savedLoad.error
          ? ` error=${savedLoad.error}`
          : ` candidates=${savedLoad.candidates.length} picked=${savedPlan.picked.length} fired=${savedFired} fresh_skipped=${savedPlan.freshSkipped} capped_out=${savedPlan.cappedOut} non_cadence=${savedPlan.nonCadenceSkipped} truncated=${savedLoad.truncated}`)
    )

    console.log(
      `[seed-wallet-refresh] done — cohort=${cohortK}/${cohortN} processed=${
        walletsWithAddress.length + walletsWithoutAddress.length
      } low_priority_skipped=${lowPrioritySkipped} lowpri_interval_h=${LOW_PRIORITY_INTERVAL_HOURS} backstop_fresh_skipped=${backstopFreshSkipped} backstop_fresh_h=${BACKSTOP_FRESH_HOURS} backfill_fired=${backfillFired} backfill_forced=${backfillForced} username_resolved=${usernameResolved} resolution_failed=${resolutionFailed} errors=${errors.length}`
    )

    // Terminal row, keyed to the INVOCATION start so it pairs with the
    // heartbeat above under the ±5s correlation query. Reached only if the
    // wave was not killed at the wall — that absence is the whole signal.
    await logInvocationRow("seed-wallet-refresh", {
      reason: "wave_dispatch",
      phase: "complete",
      processed: walletsWithAddress.length + walletsWithoutAddress.length,
      backfill_fired: backfillFired,
      low_priority_skipped: lowPrioritySkipped,
      backstop_fresh_skipped: backstopFreshSkipped,
      errors: errors.length,
      ...savedSweepExtra,
    }, new Date().toISOString())
  })

  return NextResponse.json(
    { accepted: true, started_at: new Date().toISOString() },
    { status: 202 }
  )
}

// touchCacheLastSeen retained for any future manual reuse — currently unused
// after the backfill rewrite (each wallet always gets a backfill firing).
void touchCacheLastSeen
