import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"

export const maxDuration = 300

const NBA_TOP_SHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

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

async function refreshSeededWallet(origin: string, row: SeededRow) {
  const supabase = getSupabase()
  const res = await fetch(origin + "/api/wallet-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: row.username, collection: "nba-top-shot" }),
  })
  if (!res.ok) {
    console.log("[seed-wallet-refresh] wallet-search failed for " + row.username + ": " + res.status)
    return
  }
  const json = await res.json().catch(function() { return null }) as any
  if (!json) return

  const resolvedAddress: string | null = json.walletAddress ?? null
  if (!resolvedAddress) {
    console.log("[seed-wallet-refresh] no walletAddress resolved for " + row.username)
    return
  }

  // Aggregate stats from wallet_moments_cache for accurate count/fmv/top tier.
  const { data: agg } = await supabase
    .from("wallet_moments_cache")
    .select("fmv_usd, tier")
    .eq("wallet_address", resolvedAddress)
    .eq("collection_id", NBA_TOP_SHOT_COLLECTION_ID)

  let momentCount = 0
  let fmvTotal = 0
  const tierCounts: Record<string, number> = {}
  if (Array.isArray(agg)) {
    momentCount = agg.length
    for (const r of agg as Array<{ fmv_usd: number | null; tier: string | null }>) {
      fmvTotal += Number(r.fmv_usd) || 0
      const t = (r.tier || "").trim()
      if (t) tierCounts[t] = (tierCounts[t] || 0) + 1
    }
  }
  const tierRank: Record<string, number> = { ultimate: 5, legendary: 4, rare: 3, fandom: 2, common: 1 }
  let topTier: string | null = null
  let topScore = -1
  for (const [tier, count] of Object.entries(tierCounts)) {
    const rank = tierRank[tier.toLowerCase()] ?? 0
    const score = rank * 1_000_000 + count
    if (score > topScore) { topScore = score; topTier = tier }
  }

  const { error: updErr } = await supabase
    .from("seeded_wallets")
    .update({
      last_refreshed_at: new Date().toISOString(),
      wallet_address: resolvedAddress,
      cached_moment_count: momentCount,
      cached_fmv_usd: fmvTotal,
      cached_top_tier: topTier,
    })
    .eq("id", row.id)
  if (updErr) console.log("[seed-wallet-refresh] update failed for " + row.username + ": " + updErr.message)
  else console.log("[seed-wallet-refresh] refreshed " + row.username + " → " + resolvedAddress + " (" + momentCount + " moments, $" + fmvTotal.toFixed(2) + ", top=" + (topTier || "n/a") + ")")
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  if (!token || token !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const supabase = getSupabase()
  const { data, error } = await supabase.rpc("get_seeded_wallets_due_for_refresh", {
    p_limit: 10,
    p_stale_minutes: 120,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  const rows = (data as SeededRow[] | null) ?? []
  const origin = new URL(req.url).origin

  after(async function() {
    for (const row of rows) {
      try { await refreshSeededWallet(origin, row) }
      catch (err) {
        console.log("[seed-wallet-refresh] error refreshing " + row.username + ": " + (err instanceof Error ? err.message : String(err)))
      }
    }
  })

  return NextResponse.json({
    queued: rows.length,
    usernames: rows.map(function(r) { return r.username }),
  })
}
