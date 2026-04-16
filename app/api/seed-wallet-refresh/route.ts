import { NextRequest, NextResponse } from "next/server"
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

async function refreshViaWalletSearch(
  origin: string,
  walletAddress: string
): Promise<boolean> {
  const res = await fetch(origin + "/api/wallet-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: walletAddress, collection: "nba-top-shot" }),
  })
  return res.ok
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

  const supabase = getSupabase()
  const origin = new URL(req.url).origin

  // Fetch all active seeded wallets (no stale filter — we decide freshness via cache count)
  const { data, error } = await supabase
    .from("seeded_wallets")
    .select("id, username, wallet_address, display_name, tags, priority, last_refreshed_at")
    .eq("is_active", true)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data as SeededRow[] | null) ?? []

  // Split into two groups
  const walletsWithAddress = rows.filter((r) => r.wallet_address != null)
  const walletsWithoutAddress = rows.filter((r) => r.wallet_address == null)

  const errors: string[] = []
  let cacheRefreshed = 0
  let newlySeeded = 0
  let usernameResolved = 0
  let resolutionFailed = 0

  // ── Process wallets that already have a 0x address ──────────────
  for (const row of walletsWithAddress) {
    try {
      const addr = row.wallet_address!

      // Check cache count via RPC (bypasses PostgREST 1000-row cap)
      const { data: countData, error: countErr } = await (supabase as any).rpc(
        "get_wallet_cache_count",
        { p_wallet_address: addr }
      )

      const cacheCount =
        !countErr && countData != null ? Number(countData) : 0

      if (cacheCount > 0) {
        // Cache exists — just refresh stats from existing cache rows
        await (supabase as any).rpc("refresh_seeded_wallet_stats", {
          p_wallet_address: addr,
        })
        cacheRefreshed++
        console.log(
          `[seed-wallet-refresh] cache-hit ${row.username} (${addr}): ${cacheCount} cached moments, stats refreshed`
        )
      } else {
        // Cache empty — call wallet-search to populate it
        const ok = await refreshViaWalletSearch(origin, addr)
        if (ok) {
          await (supabase as any).rpc("refresh_seeded_wallet_stats", {
            p_wallet_address: addr,
          })
          newlySeeded++
          console.log(
            `[seed-wallet-refresh] newly-seeded ${row.username} (${addr})`
          )
        } else {
          errors.push(`wallet-search failed for ${row.username}`)
          console.log(
            `[seed-wallet-refresh] wallet-search failed for ${row.username} (${addr})`
          )
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${row.username}: ${msg}`)
      console.log(`[seed-wallet-refresh] error for ${row.username}: ${msg}`)
    }

    // Sequential throttle — avoid hammering wallet-search / TS GQL
    await sleep(300)
  }

  // ── Resolve wallets that only have a username ───────────────────
  for (const row of walletsWithoutAddress) {
    try {
      const resolved = await resolveUsernameToAddress(row.username)

      if (!resolved) {
        resolutionFailed++
        console.log(
          `[seed-wallet-refresh] username resolution failed for ${row.username}`
        )
        await sleep(300)
        continue
      }

      // Persist the resolved address
      await supabase
        .from("seeded_wallets")
        .update({ wallet_address: resolved })
        .eq("id", row.id)

      usernameResolved++
      console.log(
        `[seed-wallet-refresh] resolved ${row.username} → ${resolved}`
      )

      // Now run cache-first logic with the resolved address
      const { data: countData, error: countErr } = await (supabase as any).rpc(
        "get_wallet_cache_count",
        { p_wallet_address: resolved }
      )

      const cacheCount =
        !countErr && countData != null ? Number(countData) : 0

      if (cacheCount > 0) {
        await (supabase as any).rpc("refresh_seeded_wallet_stats", {
          p_wallet_address: resolved,
        })
        cacheRefreshed++
      } else {
        const ok = await refreshViaWalletSearch(origin, resolved)
        if (ok) {
          await (supabase as any).rpc("refresh_seeded_wallet_stats", {
            p_wallet_address: resolved,
          })
          newlySeeded++
        } else {
          errors.push(`wallet-search failed for ${row.username} (resolved)`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${row.username}: ${msg}`)
      console.log(
        `[seed-wallet-refresh] error resolving ${row.username}: ${msg}`
      )
    }

    await sleep(300)
  }

  return NextResponse.json({
    processed: walletsWithAddress.length + walletsWithoutAddress.length,
    cache_refreshed: cacheRefreshed,
    newly_seeded: newlySeeded,
    username_resolved: usernameResolved,
    resolution_failed: resolutionFailed,
    errors,
  })
}
