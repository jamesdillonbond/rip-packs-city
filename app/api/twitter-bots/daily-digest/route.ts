// app/api/twitter-bots/daily-digest/route.ts
// Posts a 2-tweet daily market thread. Skips if a digest was posted in the
// last 20 hours. Auth: Bearer INGEST_SECRET_TOKEN.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { postTweet, postReply } from "@/lib/twitter"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

const COLLECTION_EMOJI: Record<string, string> = {
  "NBA Top Shot": "🏀",
  "NFL All Day": "🏈",
  "LaLiga Golazos": "⚽",
  "Disney Pinnacle": "🪄",
  "UFC Strike": "🥊",
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "$0"
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString()
  return "$" + Number(n).toFixed(0)
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Skip if a daily digest was posted in last 20h
    const since = new Date(Date.now() - 20 * 3600_000).toISOString()
    const { data: recent } = await (supabaseAdmin as any)
      .from("posted_digests")
      .select("id, posted_at")
      .eq("digest_type", "daily")
      .gte("posted_at", since)
      .limit(1)
    if (recent && recent.length > 0) {
      return NextResponse.json({ posted: false, reason: "digest within last 20h" })
    }

    const { data: pulse } = await (supabaseAdmin as any).rpc("get_market_pulse_all")
    const pulseRows: Array<{
      collection_name: string; sales_24h: number; volume_24h: number; top_sale_24h: number | null
    }> = pulse ?? []

    const totalVolume = pulseRows.reduce((s, r) => s + Number(r.volume_24h ?? 0), 0)
    const totalSales = pulseRows.reduce((s, r) => s + Number(r.sales_24h ?? 0), 0)
    const activeCols = pulseRows.filter(r => Number(r.sales_24h ?? 0) > 0).length

    // Top sale across collections — query sales for the actual top moment
    const { data: topSaleRows } = await (supabaseAdmin as any)
      .from("sales")
      .select("price_usd, player_name, tier")
      .gte("sold_at", new Date(Date.now() - 24 * 3600_000).toISOString())
      .order("price_usd", { ascending: false })
      .limit(1)
    const topSale = topSaleRows?.[0] ?? null

    // Top deal for the second tweet
    const { data: dealsRpc } = await (supabaseAdmin as any).rpc("get_cross_collection_deals", {
      p_limit: 1, p_min_discount: 25,
    })
    const topDeal = (dealsRpc?.deals ?? [])[0] ?? null

    const tweet1 = `📊 RPC Daily Market Report

💵 24h Volume: ${fmtUsd(totalVolume)}
📈 Sales: ${totalSales.toLocaleString()} across ${activeCols} collections
🏆 Top Sale: ${topSale?.player_name ?? "—"} (${topSale?.tier ?? "—"}) ${fmtUsd(topSale?.price_usd)}

Powered by rippackscity.com`

    const lines: string[] = ["Collection breakdown:"]
    for (const r of pulseRows.slice(0, 3)) {
      const emoji = COLLECTION_EMOJI[r.collection_name] ?? "•"
      lines.push(`${emoji} ${r.collection_name.replace(/^NBA |^NFL |^LaLiga |^Disney |^UFC /, "")}: ${fmtUsd(r.volume_24h)} (${r.sales_24h} sales)`)
    }
    const dealLine = topDeal
      ? `\nBest deal right now: ${topDeal.player_name} at ${Math.round(topDeal.discount ?? 0)}% off`
      : ""
    const tweet2 = `${lines.join("\n")}${dealLine}
rippackscity.com/nba-top-shot/sniper`

    const first = await postTweet(tweet1)
    let secondId: string | null = null
    if (first?.id) {
      const second = await postReply(tweet2, first.id)
      secondId = second?.id ?? null
    }

    try {
      await (supabaseAdmin as any).from("posted_digests").insert({
        digest_type: "daily",
        tweet_id: first?.id ?? null,
        total_sales: totalSales,
        total_volume: totalVolume,
        top_sale_price: topSale?.price_usd ?? null,
        top_sale_player: topSale?.player_name ?? null,
      })
    } catch (e) { console.error("[daily-digest] insert failed:", e instanceof Error ? e.message : String(e)) }

    return NextResponse.json({
      posted: true,
      tweet_ids: [first?.id ?? null, secondId],
      total_sales: totalSales,
      total_volume: totalVolume,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
