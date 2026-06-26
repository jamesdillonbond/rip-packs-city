import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// POST /api/cron/resolve-wallet-usernames — Bearer $INGEST_SECRET_TOKEN (or ?token=)
//
// Item 3 (2026-06-09): populate the wallet_usernames cache so the platform can
// show @handles instead of raw 0x addresses. Pulls a batch of recent TS sale
// counterparties missing a username (RPC wallet_usernames_unresolved), resolves
// each via Top Shot's getUserProfile GQL THROUGH the topshot-proxy worker
// (public-api.nbatopshot.com blocks Vercel egress), and upserts the result.
// Misses are written with username=NULL + last_attempted_at so a >14d negative
// cache stops us re-fetching dead addresses every tick.
//
// getUserProfile(input:{flowAddress}) is the address->profile lookup on the same
// public-api schema as getUserProfileByUsername (the reverse direction used by
// lib/chains/flow/topshot-username-resolve.ts). The earlier searchUsers query
// did not exist on any reachable endpoint, so this resolver wrote nothing.
// FOOTGUN: getUserProfile wants the BARE hex address (no 0x prefix) — the
// 0x-prefixed form returns "failed to get user from consumer search".
//
// Dapper SSO = one username per wallet across all 4 Flow collections, so a
// single TS resolution is authoritative. Fire-and-forget; ~5 req/s throttle.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""
const PIPELINE_NAME = "wallet-username-resolver"
// 2026-06-26: Cowork widened wallet_usernames_unresolved to all collections + all
// sources (was TS-onchain only), creating a one-time backlog of previously-
// unreachable wallets. Raised 150->300 to drain faster; at 200ms/req that's ~60s,
// well under maxDuration=120. Revert to 150 once the backlog clears.
const BATCH = 300
const REQUEST_INTERVAL_MS = 200

export const dynamic = "force-dynamic"
export const maxDuration = 120

const PROFILE_QUERY = `
  query ResolveUserByAddress($addr: String!) {
    getUserProfile(input: { flowAddress: $addr }) {
      publicInfo { username flowAddress }
    }
  }
`.trim()

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Tri-state so the loop can negative-cache true misses (status_code 5 /
// no-profile) without poisoning the 14-day cache on a transient upstream blip.
type LookupResult =
  | { status: "hit"; username: string }
  | { status: "miss" }
  | { status: "error" }

async function lookupUsername(addr: string): Promise<LookupResult> {
  // getUserProfile's flowAddress lookup wants the bare hex (no 0x prefix).
  const bareAddr = addr.replace(/^0x/i, "")
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (TS_PROXY_SECRET) headers["x-proxy-secret"] = TS_PROXY_SECRET
  try {
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: PROFILE_QUERY, variables: { addr: bareAddr } }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    // Transport/HTTP failure (incl. GQL validation 422) — treat as transient.
    if (!res.ok) return { status: "error" }
    const body: any = await res.json()
    const username: unknown = body?.data?.getUserProfile?.publicInfo?.username
    if (typeof username === "string" && username.trim()) {
      return { status: "hit", username: username.trim() }
    }
    // HTTP 200 with no profile: not-found surfaces as errors[].status_code=5.
    // No username + no error is also a clean miss. Either way, negative-cache it.
    return { status: "miss" }
  } catch {
    return { status: "error" }
  }
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

  after(async () => {
    let found = 0
    let resolved = 0
    let missed = 0
    let errored = 0
    let ok = true
    let errMsg: string | null = null

    try {
      const { data, error } = await (supabaseAdmin as any).rpc("wallet_usernames_unresolved", {
        p_limit: BATCH,
      })
      if (error) {
        ok = false
        errMsg = error.message
        console.log(`[username-resolver] unresolved rpc err: ${error.message}`)
        return
      }
      const addrs: string[] = Array.isArray(data) ? data : []
      found = addrs.length

      for (let i = 0; i < addrs.length; i++) {
        const addr = String(addrs[i]).toLowerCase()
        const result = await lookupUsername(addr)
        const nowIso = new Date().toISOString()
        if (result.status === "error") {
          // Transient — leave the address for the next tick (no row written).
          errored++
        } else if (result.status === "hit") {
          const { error: upErr } = await (supabaseAdmin as any)
            .from("wallet_usernames")
            .upsert(
              {
                wallet_addr: addr,
                username: result.username,
                source: "topshot_gql",
                resolved_at: nowIso,
                updated_at: nowIso,
                last_attempted_at: nowIso,
              },
              { onConflict: "wallet_addr" },
            )
          if (upErr) console.log(`[username-resolver] upsert hit err ${addr}: ${upErr.message}`)
          else resolved++
        } else {
          // Miss — negative-cache so wallet_usernames_unresolved skips it for 14d.
          // The unresolved RPC never returns already-resolved (username NOT NULL)
          // addresses, so this can't clobber a good handle.
          const { error: upErr } = await (supabaseAdmin as any)
            .from("wallet_usernames")
            .upsert(
              {
                wallet_addr: addr,
                username: null,
                source: "gql_miss",
                updated_at: nowIso,
                last_attempted_at: nowIso,
              },
              { onConflict: "wallet_addr" },
            )
          if (upErr) console.log(`[username-resolver] upsert miss err ${addr}: ${upErr.message}`)
          else missed++
        }
        if (i < addrs.length - 1) await delay(REQUEST_INTERVAL_MS)
      }
    } catch (err) {
      ok = false
      errMsg = err instanceof Error ? err.message : String(err)
      console.log(`[username-resolver] fatal: ${errMsg}`)
    } finally {
      try {
        await (supabaseAdmin as any).from("pipeline_runs").insert({
          pipeline: PIPELINE_NAME,
          collection_slug: "nba-top-shot",
          started_at: startedAtIso,
          finished_at: new Date().toISOString(),
          rows_found: found,
          rows_written: resolved,
          rows_skipped: missed,
          ok,
          error: errMsg ? errMsg.slice(0, 500) : null,
          extra: { resolved, missed, errored, batch: BATCH, duration_ms: Date.now() - startedAt },
        })
      } catch {
        /* logging best-effort */
      }
      console.log(`[username-resolver] done found=${found} resolved=${resolved} missed=${missed} errored=${errored}`)
    }
  })

  return NextResponse.json({
    ok: true,
    queued: true,
    note: "Wallet username resolution queued; progress in pipeline_runs (wallet-username-resolver).",
  })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
