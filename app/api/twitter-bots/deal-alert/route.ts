// app/api/twitter-bots/deal-alert/route.ts
// Posts up to 3 deal-alert tweets per cron run.
// Auth: Bearer INGEST_SECRET_TOKEN

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { postTweet } from "@/lib/twitter"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const MAX_POSTS = 3

const COLLECTION_HASHTAGS: Record<string, string> = {
  "NBA Top Shot": "#NBATopShot #NFT #FlowBlockchain",
  "NFL All Day": "#NFLAllDay #NFT #FlowBlockchain",
  "LaLiga Golazos": "#LaLigaGolazos #NFT #FlowBlockchain",
  "Disney Pinnacle": "#DisneyPinnacle #NFT #FlowBlockchain",
  "UFC Strike": "#UFCStrike #NFT",
}

type Deal = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  ask_price: number | null
  fmv: number | null
  discount: number | null
  buy_url: string | null
  source: string | null
  serial_number: number | null
  circulation_count: number | null
  collection_name: string | null
}

function tweetText(d: Deal): string {
  const tag = COLLECTION_HASHTAGS[d.collection_name ?? ""] ?? "#NFT #FlowBlockchain"
  const player = d.player_name ?? "Unknown"
  const tier = d.tier ?? "COMMON"
  const setName = d.set_name ?? ""
  const ask = (d.ask_price ?? 0).toFixed(2)
  const fmv = (d.fmv ?? 0).toFixed(2)
  const disc = Math.round(d.discount ?? 0)
  const url = d.buy_url ?? ""
  return `🔥 DEAL: ${player} (${tier}) — ${setName}
💰 $${ask} (FMV $${fmv})
📉 ${disc}% below FMV
🏀 ${d.collection_name ?? ""}

${url}

${tag}`
}

function dealKey(d: Deal): string {
  return [d.player_name ?? "", d.set_name ?? "", (d.ask_price ?? 0).toFixed(2)].join("|")
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { data: rpc, error } = await (supabaseAdmin as any).rpc("get_cross_collection_deals", {
      p_limit: 5, p_min_discount: 25,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const deals: Deal[] = (rpc?.deals ?? []) as Deal[]

    // Pull recent posted alerts (last 24h) for dedup
    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    const { data: recent } = await (supabaseAdmin as any)
      .from("posted_listing_alerts")
      .select("player_name, set_name, ask_price")
      .gte("posted_at", since)
    const seen = new Set<string>(
      (recent ?? []).map((r: any) =>
        [r.player_name ?? "", r.set_name ?? "", Number(r.ask_price ?? 0).toFixed(2)].join("|")
      )
    )

    let posted = 0
    for (const d of deals) {
      if (posted >= MAX_POSTS) break
      const key = dealKey(d)
      if (seen.has(key)) continue
      const text = tweetText(d)
      const result = await postTweet(text)
      const tweetId = result?.id ?? null
      try {
        await (supabaseAdmin as any).from("posted_listing_alerts").insert({
          tweet_id: tweetId,
          player_name: d.player_name,
          set_name: d.set_name,
          tier: d.tier,
          ask_price: d.ask_price,
          fmv_usd: d.fmv,
          discount_pct: d.discount,
          serial_number: d.serial_number,
          circulation_count: d.circulation_count,
          source: d.source,
        })
      } catch (e) { console.error("[deal-alert] insert failed:", e instanceof Error ? e.message : String(e)) }
      seen.add(key)
      if (tweetId) posted += 1
    }

    return NextResponse.json({ checked: deals.length, posted })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
