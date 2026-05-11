import { NextRequest, NextResponse, after } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const maxDuration = 300

// Cap concurrent /api/wallet-backfill-multicollection dispatches at this
// number. Each dispatch fans out to 5 collection-specific child routes,
// each of which uses Next.js `after()` to run heavy DB work in the
// background past response time. With ~200 seeded wallets × 5 children,
// an unbounded fan-out at HH:00 spawns ~1000 background workers, all
// competing for the 60-conn Supabase pool — saturation cascades into the
// other crons that fire at HH:05 (pinnacle-resolver, sync-flowty,
// wmc-fmv-populate). 8-in-flight keeps the burst absorption window tight
// without changing the cron schedule.
//
// Caveat: this caps in-flight dispatch fetches, NOT the background
// after() workers each child spawns. Truly throttling pool usage would
// require children to run synchronously and the orchestrator to await
// completion (today they return 202 immediately). 8-in-flight smooths the
// initial burst at HH:00 and is the minimum-blast-radius change that
// matches the audit ask.
const DISPATCH_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }
  const workers = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workers }, () => runWorker()))
  return results
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
    const walletsWithAddress = rows.filter((r) => r.wallet_address != null)
    const walletsWithoutAddress = rows.filter((r) => r.wallet_address == null)

    const errors: string[] = []
    let backfillFired = 0
    let backfillForced = 0
    let usernameResolved = 0
    let resolutionFailed = 0

    // ── Wallets with known address — bounded fan-out ──────────────────
    // Bounded at DISPATCH_CONCURRENCY (8). Replaces the prior
    // sequential-with-250ms-sleep loop that, while slow, did not actually
    // bound peak concurrent /api/wallet-backfill-multicollection requests
    // (a fast Vercel cold-start could overlap two dispatches; the loop
    // also didn't gate against the 5x fan-out each multicollection child
    // does internally).
    await mapWithConcurrency(walletsWithAddress, DISPATCH_CONCURRENCY, async (row) => {
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

    // ── Wallets with only a username — same bounded fan-out ──────────
    await mapWithConcurrency(walletsWithoutAddress, DISPATCH_CONCURRENCY, async (row) => {
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

    console.log(
      `[seed-wallet-refresh] done — processed=${
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
