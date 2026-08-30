import { NextRequest, NextResponse, after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

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
async function dispatchPaced(tasks: Array<() => Promise<void>>): Promise<void> {
  const startMs = Date.now()
  const batches = chunk(tasks, DISPATCH_BATCH_SIZE)
  const gaps = Math.max(1, batches.length - 1)
  const pauseMs = Math.min(MAX_PAUSE_MS, Math.floor(TARGET_SPREAD_MS / gaps))
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
//   SEED_REFRESH_BACKSTOP_FRESH_HOURS (default 3)
const BACKSTOP_FRESH_HOURS = Number(process.env.SEED_REFRESH_BACKSTOP_FRESH_HOURS ?? 3)
const BACKSTOP_FRESH_MS =
  (Number.isFinite(BACKSTOP_FRESH_HOURS) ? Math.max(0, BACKSTOP_FRESH_HOURS) : 3) * 60 * 60 * 1000

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
    utcHour % 12 >= 2

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
