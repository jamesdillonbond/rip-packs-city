// app/api/twitter-bots/badge-spotlight/route.ts
// Picks a random badge type, finds the cheapest listed moment that has it,
// posts a spotlight tweet. Once per day. Auth: Bearer INGEST_SECRET_TOKEN.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { postTweet } from "@/lib/twitter"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

const COLLECTION_HASHTAGS: Record<string, string> = {
  "nba-top-shot": "#NBATopShot #Badges",
  "nfl-all-day": "#NFLAllDay #Badges",
  "laliga-golazos": "#LaLigaGolazos #Badges",
}

const COLLECTION_SLUG_BY_ID: Record<string, string> = {
  "95f28a17-224a-4025-96ad-adf8a4c63bfd": "nba-top-shot",
  "dee28451-5d62-409e-a1ad-a83f763ac070": "nfl-all-day",
  "06248cc4-b85f-47cd-af67-1855d14acd75": "laliga-golazos",
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Once-per-day check
    const since = new Date(Date.now() - 22 * 3600_000).toISOString()
    const { data: recent } = await (supabaseAdmin as any)
      .from("posted_digests")
      .select("id")
      .eq("digest_type", "badge_spotlight")
      .gte("posted_at", since)
      .limit(1)
    if (recent && recent.length > 0) {
      return NextResponse.json({ posted: false, reason: "spotlight within last 22h" })
    }

    // Fetch a small candidate pool of badged editions with low_ask + fmv
    const { data: candidates } = await (supabaseAdmin as any)
      .from("badge_editions")
      .select("player_name, set_name, tier, low_ask, avg_sale_price, play_tags, collection_id")
      .not("low_ask", "is", null)
      .gt("low_ask", 0)
      .not("play_tags", "is", null)
      .limit(200)

    const pool = (candidates ?? []).filter((r: any) => Array.isArray(r.play_tags) && r.play_tags.length > 0)
    if (pool.length === 0) {
      return NextResponse.json({ posted: false, reason: "no candidates" })
    }

    // Pick a random badge type from the pool
    const allTags = Array.from(new Set(pool.flatMap((r: any) => r.play_tags as string[])))
    const badgeType = allTags[Math.floor(Math.random() * allTags.length)] as string

    // Cheapest listing for that badge
    const matching = pool
      .filter((r: any) => (r.play_tags as string[]).includes(badgeType))
      .sort((a: any, b: any) => Number(a.low_ask) - Number(b.low_ask))
    const pick = matching[0]
    if (!pick) {
      return NextResponse.json({ posted: false, reason: "no listings for badge" })
    }

    const fmv = Number(pick.avg_sale_price ?? pick.low_ask)
    const ask = Number(pick.low_ask)
    const premium = fmv > 0 ? Math.round(((fmv - ask) / fmv) * 100) : 0
    const slug = COLLECTION_SLUG_BY_ID[pick.collection_id] ?? "nba-top-shot"
    const hashtags = COLLECTION_HASHTAGS[slug] ?? "#NFT #Badges"

    const text = `⭐ Badge Spotlight: ${String(badgeType).toUpperCase()}

${pick.player_name ?? "Unknown"} — ${pick.set_name ?? ""} (${pick.tier ?? "COMMON"})
🏷️ Listed at $${ask.toFixed(2)} | FMV $${fmv.toFixed(2)}
📊 Badge premium: ${premium >= 0 ? "+" : ""}${premium}%

Find badged deals → rippackscity.com/${slug}/sniper

${hashtags}`

    const tweet = await postTweet(text)

    try {
      await (supabaseAdmin as any).from("posted_digests").insert({
        digest_type: "badge_spotlight",
        tweet_id: tweet?.id ?? null,
        top_sale_player: pick.player_name,
        top_set_name: pick.set_name,
        top_sale_price: ask,
        collection_id: pick.collection_id,
      })
    } catch (e) { console.error("[badge-spotlight] insert failed:", e instanceof Error ? e.message : String(e)) }

    return NextResponse.json({
      posted: !!tweet,
      tweet_id: tweet?.id ?? null,
      badge_type: badgeType,
      player: pick.player_name,
      ask,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
