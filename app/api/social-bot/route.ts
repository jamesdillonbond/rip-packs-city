/**
 * app/api/social-bot/route.ts
 *
 * RPC Daily Deal Bot — Phase 2
 *
 * Selects the top deals from the sniper feed, deduplicates against
 * posted_deals, generates OG card images, and posts to @RipPacksCity.
 *
 * Called by GitHub Actions cron (.github/workflows/social-bot.yml)
 * Auth: INGEST_SECRET_TOKEN (same as pipeline)
 *
 * GET /api/social-bot?secret=<token>&dry_run=1   — preview only, no posting
 * GET /api/social-bot?secret=<token>             — live post
 */

import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { postTweetWithMedia } from "@/lib/twitter/post"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://rip-packs-city.vercel.app"

const MAX_POSTS = 3
const MIN_DISCOUNT_PCT = 20
const DEDUP_HOURS = 48

interface SniperDeal {
  flowId: string
  editionKey: string
  playerName: string
  setName: string
  tier: string
  serialNumber: number
  totalEditions: number
  askPrice: number
  fmv: number
  discountPct: number
  badges: string[]
  source: "topshot" | "flowty"
  listingResourceID?: string
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)

  if (searchParams.get("secret") !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const dryRun = searchParams.get("dry_run") === "1"

  try {
    // ── 1. Fetch sniper feed ──────────────────────────────────────────
    const feedRes = await fetch(`${BASE_URL}/api/sniper-feed`, {
      headers: { "x-internal": "social-bot" },
    })
    if (!feedRes.ok) throw new Error(`Sniper feed error: ${feedRes.status}`)
    const feedData = await feedRes.json()
    const allDeals: SniperDeal[] = feedData.deals ?? feedData.rows ?? []

    if (allDeals.length === 0) {
      return NextResponse.json({ message: "No deals available", posted: 0 })
    }

    // ── 2. Filter to tweet-worthy deals ──────────────────────────────
    const candidates = allDeals
      .filter((d) => d.discountPct >= MIN_DISCOUNT_PCT && d.fmv > 0 && d.askPrice > 0)
      .sort((a, b) => b.discountPct - a.discountPct)

    if (candidates.length === 0) {
      return NextResponse.json({
        message: `No deals above ${MIN_DISCOUNT_PCT}% discount`,
        posted: 0,
      })
    }

    // ── 3. Dedup against posted_deals ────────────────────────────────
    const cutoff = new Date(Date.now() - DEDUP_HOURS * 60 * 60 * 1000).toISOString()
    const { data: recentPosts } = await supabase
      .from("posted_deals")
      .select("edition_key")
      .gte("posted_at", cutoff)

    const recentEditionKeys = new Set<string>(
      (recentPosts ?? []).map((r: any) => r.edition_key)
    )

    const fresh = candidates.filter(
      (d) => !recentEditionKeys.has(d.editionKey || d.flowId)
    )

    if (fresh.length === 0) {
      return NextResponse.json({
        message: "All top deals already posted recently",
        posted: 0,
        dedupedCount: candidates.length,
      })
    }

    // ── 4. Pick top N and post ────────────────────────────────────────
    const toPost = fresh.slice(0, MAX_POSTS)
    const results: any[] = []

    for (const deal of toPost) {
      try {
        const ogParams = new URLSearchParams({
          player: deal.playerName,
          tier: deal.tier,
          serial: String(deal.serialNumber),
          listed: deal.askPrice.toFixed(2),
          fmv: deal.fmv.toFixed(2),
          pct: String(Math.round(deal.discountPct)),
          source: deal.source,
          ...(deal.badges?.[0] ? { badge: deal.badges[0] } : {}),
        })
        const ogUrl = `${BASE_URL}/api/og/deal?${ogParams.toString()}`

        const buyLink =
          deal.source === "flowty" && deal.listingResourceID
            ? `https://www.flowty.io/listing/${deal.listingResourceID}`
            : `https://nbatopshot.com/marketplace/moment/${deal.flowId}`

        const badgeStr = deal.badges?.length ? ` ${deal.badges[0]}` : ""
        const tweetText =
          `🎯 SNIPER ALERT${badgeStr}\n\n` +
          `${deal.playerName} — ${deal.tier}\n` +
          `Serial #${deal.serialNumber} / ${deal.totalEditions}\n\n` +
          `Listed: $${deal.askPrice.toFixed(2)}\n` +
          `FMV: $${deal.fmv.toFixed(2)}\n` +
          `🔥 ${Math.round(deal.discountPct)}% below market\n\n` +
          `${buyLink}\n\n` +
          `#NBAtopshot #RipPacksCity`

        if (dryRun) {
          results.push({
            dryRun: true,
            deal: deal.playerName,
            pct: deal.discountPct,
            tweetText,
            ogUrl,
          })
          continue
        }

        const tweetRes = await postTweetWithMedia("rpc", tweetText, ogUrl)

        await supabase.from("posted_deals").insert({
          edition_key: deal.editionKey || deal.flowId,
          flow_id: deal.flowId,
          player_name: deal.playerName,
          tier: deal.tier,
          ask_price: deal.askPrice,
          fmv: deal.fmv,
          discount_pct: Math.round(deal.discountPct),
          source: deal.source,
          tweet_id: tweetRes.data?.id ?? null,
          posted_at: new Date().toISOString(),
        })

        if (tweetRes.data?.id) {
          await supabase.from("posted_tweets").insert({
            tweet_id: tweetRes.data.id,
            brand: "rpc",
            tweet_type: "sniper_deal",
            text: tweetText,
            metadata: {
              player: deal.playerName,
              tier: deal.tier,
              discountPct: Math.round(deal.discountPct),
            },
            posted_at: new Date().toISOString(),
          })
        }

        results.push({
          success: true,
          deal: deal.playerName,
          pct: deal.discountPct,
          tweetId: tweetRes.data?.id,
        })

        if (toPost.indexOf(deal) < toPost.length - 1) {
          await new Promise((r) => setTimeout(r, 8000))
        }
      } catch (err: any) {
        console.error(`[social-bot] Failed to post ${deal.playerName}:`, err.message)
        results.push({ success: false, deal: deal.playerName, error: err.message })
      }
    }

    const posted = results.filter((r) => r.success || r.dryRun).length
    console.log(
      `[social-bot] Run complete. Posted: ${posted}/${toPost.length}. DryRun: ${dryRun}`
    )

    return NextResponse.json({
      posted,
      dryRun,
      results,
      candidatesFound: candidates.length,
      freshDeals: fresh.length,
    })
  } catch (err: any) {
    console.error("[social-bot] Fatal error:", err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}