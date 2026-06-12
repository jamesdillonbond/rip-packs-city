import { NextRequest, NextResponse, after } from "next/server"
import { createClient } from "@supabase/supabase-js"

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

  const origin = new URL(req.url).origin
  const ingestToken = process.env.INGEST_SECRET_TOKEN!

  after(async () => {
    const supabase = getSupabase()

    const { data, error } = await supabase
      .from("seeded_wallets")
      .select("id, username, wallet_address, display_name, tags, priority, last_refreshed_at, cached_moment_count")
      .eq("is_active", true)

    if (error) {
      console.log(`[seed-wallet-refresh] fetch error: ${error.message}`)
      return
    }

    const rows = (data as SeededRow[] | null) ?? []
    // When split into cohorts, keep only this cohort's slice by id-modulo.
    const cohortRows =
      cohortN > 1 ? rows.filter((r) => r.id % cohortN === cohortK) : rows
    const walletsWithAddress = cohortRows.filter((r) => r.wallet_address != null)
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
      } backfill_fired=${backfillFired} backfill_forced=${backfillForced} username_resolved=${usernameResolved} resolution_failed=${resolutionFailed} errors=${errors.length}`
    )
  })

  return NextResponse.json(
    { accepted: true, started_at: new Date().toISOString() },
    { status: 202 }
  )
}

// touchCacheLastSeen retained for any future manual reuse — currently unused
// after the backfill rewrite (each wallet always gets a backfill firing).
void touchCacheLastSeen
