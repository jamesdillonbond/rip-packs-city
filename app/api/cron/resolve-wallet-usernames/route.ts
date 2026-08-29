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
  // ⚠ `reason` added 2026-08-29. It used to be a bare `{ status: "error" }`, so
  // when EVERY lookup failed the run had nothing to report but a count — and it
  // reported that count as a success (see the `ok` derivation below). A tally
  // without a cause cannot be triaged: on 2026-08-29 six consecutive runs logged
  // errored 19 → 50 → 55 → 57 → 60 → 63, all `ok: true`, and identifying the
  // cause required reading a DIFFERENT pipeline's error column.
  | { status: "error"; reason: string }

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
    if (!res.ok) return { status: "error", reason: `http ${res.status}` }
    const body: any = await res.json()
    const username: unknown = body?.data?.getUserProfile?.publicInfo?.username
    if (typeof username === "string" && username.trim()) {
      return { status: "hit", username: username.trim() }
    }
    // HTTP 200 with no profile: not-found surfaces as errors[].status_code=5.
    // No username + no error is also a clean miss. Either way, negative-cache it.
    return { status: "miss" }
  } catch (e) {
    // Name + message, not the whole error: this string reaches `pipeline_runs.error`,
    // and an upstream body can carry markup or a token. AbortSignal.timeout surfaces
    // as TimeoutError, which is the one worth telling apart from a transport fault.
    const name = e instanceof Error ? e.name : "unknown"
    const msg = e instanceof Error ? e.message : String(e)
    return { status: "error", reason: `${name}: ${msg}`.slice(0, 120) }
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
    let firstErrReason: string | null = null
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
          if (firstErrReason === null) firstErrReason = result.reason
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
          // 🚨 A RUN IN WHICH EVERY LOOKUP FAILED IS NOT A SUCCESS (2026-08-29).
          // `ok` starts true and used to be lowered ONLY by the Supabase RPC that
          // fetches the queue. Per-address upstream failures just incremented
          // `errored`, so a total outage of Top Shot's GQL logged `ok: true`,
          // `rows_written: 0` — and the sentinel's Pipeline Success Coverage arm
          // (zero successes AND zero rows written) could never see it, because the
          // run claimed a success. Measured that day: six consecutive runs at
          // errored = found (19/19 … 63/63), every one green, while
          // `public-api.nbatopshot.com` had been answering 530/1033 for 22 hours.
          //
          // ⚠ THE PREDICATE IS "EVERY ATTEMPT ERRORED", NOT "ANY ERRORED".
          // A single flaky address must not redden a run that resolved 299 others —
          // that is the noisy form this repo has already rejected once for the
          // cadence arms. `found > 0` keeps an EMPTY QUEUE green: nothing was
          // attempted, so nothing failed, and a drained backlog is the healthy
          // steady state for this pipeline.
          // ⚠ `missed` is deliberately NOT counted as a failure — a wallet with no
          // Top Shot profile is a real answer, and it is the reason this lookup is
          // tri-state rather than boolean.
          ok: ok && !(found > 0 && errored === found),
          error:
            errMsg
              ? errMsg.slice(0, 500)
              : found > 0 && errored === found
                ? `all ${errored} username lookups failed; first: ${firstErrReason ?? "unknown"}`.slice(0, 500)
                : null,
          extra: {
            resolved,
            missed,
            errored,
            first_error_reason: firstErrReason,
            batch: BATCH,
            duration_ms: Date.now() - startedAt,
          },
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
