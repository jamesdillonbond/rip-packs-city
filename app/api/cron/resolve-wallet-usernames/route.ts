import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// POST /api/cron/resolve-wallet-usernames — Bearer $INGEST_SECRET_TOKEN (or ?token=)
//
// Item 3 (2026-06-09): populate the wallet_usernames cache so the platform can
// show @handles instead of raw 0x addresses. Pulls a batch of recent TS sale
// counterparties missing a username (RPC wallet_usernames_unresolved), resolves
// each via Top Shot's searchUsers GQL THROUGH the topshot-proxy worker
// (public-api.nbatopshot.com blocks Vercel egress), and upserts the result.
// Misses are written with username=NULL + last_attempted_at so a >14d negative
// cache stops us re-fetching dead addresses every tick.
//
// Dapper SSO = one username per wallet across all 4 Flow collections, so a
// single TS resolution is authoritative. Fire-and-forget; ~5 req/s throttle.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TS_GQL = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""
const PIPELINE_NAME = "wallet-username-resolver"
const BATCH = 150
const REQUEST_INTERVAL_MS = 200

export const dynamic = "force-dynamic"
export const maxDuration = 120

const SEARCH_USERS_QUERY = `
  query SearchUsersByAddress($input: SearchUsersInput!, $paginationInput: BasePaginationV2Input!) {
    searchUsers(input: $input, paginationInput: $paginationInput) {
      searchSummary {
        data {
          ... on Users {
            data {
              ... on User {
                publicInfo { username flowAddress }
              }
            }
          }
        }
      }
    }
  }
`.trim()

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function searchUsername(addr: string): Promise<string | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (TS_PROXY_SECRET) headers["x-proxy-secret"] = TS_PROXY_SECRET
  try {
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: SEARCH_USERS_QUERY,
        variables: {
          input: { searchPhrase: addr },
          paginationInput: { cursor: "", direction: "RIGHT", limit: 5 },
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body: any = await res.json()
    if (body?.errors?.length) return null
    const items: any[] = body?.data?.searchUsers?.searchSummary?.data?.data ?? []
    if (!items.length) return null
    const lower = addr.toLowerCase()
    let pick = items.find((u) => (u?.publicInfo?.flowAddress || "").toLowerCase() === lower)
    if (!pick) pick = items[0]
    const username: string | undefined = pick?.publicInfo?.username
    if (!username || typeof username !== "string") return null
    return username
  } catch {
    return null
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
        const username = await searchUsername(addr)
        const nowIso = new Date().toISOString()
        if (username) {
          const { error: upErr } = await (supabaseAdmin as any)
            .from("wallet_usernames")
            .upsert(
              {
                wallet_addr: addr,
                username,
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
          extra: { resolved, missed, batch: BATCH, duration_ms: Date.now() - startedAt },
        })
      } catch {
        /* logging best-effort */
      }
      console.log(`[username-resolver] done found=${found} resolved=${resolved} missed=${missed}`)
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
