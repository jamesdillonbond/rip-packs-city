import { NextRequest, NextResponse, after } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const maxDuration = 300

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

// Fire wallet-backfill (Cadence walk over col.getIDs()) instead of
// wallet-search (which paginates with default limit=24 and was the source of
// the May 6 truncation bug — wallets like Rigged ended up with 101 cached
// moments out of 33,000+ on-chain). wallet-backfill returns 202 immediately
// and continues enrichment in the background up to ~260s. We don't await
// completion here because the parent after() lifetime is shared across all
// 600+ active seeded wallets.
async function refreshViaWalletBackfill(
  origin: string,
  walletAddress: string,
  ingestToken: string,
  forceFullWalk: boolean
): Promise<boolean> {
  try {
    const res = await fetch(origin + "/api/wallet-backfill", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestToken}`,
      },
      body: JSON.stringify({
        wallet: walletAddress,
        // Default-true on the route side; pass false explicitly when we want a
        // forced re-walk (e.g. detected drift > tolerance).
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

    for (const row of walletsWithAddress) {
      try {
        const addr = row.wallet_address!
        const cached = row.cached_moment_count ?? 0
        // Force a full re-walk when the count is at a known truncation
        // signature OR is zero. Otherwise the backfill route's default
        // skip_cached=true keeps refreshes lean.
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

      // Light throttle so we don't spawn 600 concurrent Vercel invocations.
      // 250ms × 600 wallets = 2.5 minutes to fan out, still inside the 300s
      // ceiling. The fanned-out backfill calls each have their own 300s
      // background lifetime, independent of this caller's clock.
      await sleep(250)
    }

    // Resolve wallets that only have a username, then fire backfill.
    for (const row of walletsWithoutAddress) {
      try {
        const resolved = await resolveUsernameToAddress(row.username)
        if (!resolved) {
          resolutionFailed++
          console.log(
            `[seed-wallet-refresh] username resolution failed for ${row.username}`
          )
          await sleep(250)
          continue
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

      await sleep(250)
    }

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
