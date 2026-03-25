import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/topshot"

// Secret token guard — set MARKET_FEED_TOKEN in Vercel env vars.
// RPC_EXTERNAL_MARKET_URL should include this token as a query param:
//   https://rip-packs-city.vercel.app/api/market-feed?token=YOUR_TOKEN
const FEED_TOKEN = process.env.MARKET_FEED_TOKEN

// Max editions to fetch per run — keeps the route under Vercel's 60s timeout.
// At ~200ms per setID group this handles ~300 editions comfortably.
const MAX_EDITIONS = 500

type EditionStats = {
  editionKey: string
  lowAsk: number | null
  bestOffer: number | null
  lastSale: number | null
  askCount: number
  offerCount: number
  saleCount: number
  source: string
  tags: string[]
}

type TopShotEditionStatsResponse = {
  searchEditions: {
    data: Array<{
      set: { id: string }
      play: { id: string }
      stats: {
        lowestAsk: number | null
        averagePrice: number | null
        totalSales: number | null
        currentBuyNowPrice: number | null
      } | null
    }>
  }
}

// ─── Supabase: load all known edition keys ────────────────────────────────────

async function loadEditionKeysFromSupabase(): Promise<string[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("editions")
      .select("external_id")
      .not("external_id", "is", null)
      .limit(MAX_EDITIONS)

    if (error || !data) {
      console.warn("[market-feed] Supabase error:", error?.message)
      return []
    }

    return data
      .map((r: { external_id: string }) => r.external_id)
      .filter((id: string) => typeof id === "string" && id.includes(":"))
  } catch (e) {
    console.warn("[market-feed] Exception loading editions:", e instanceof Error ? e.message : e)
    return []
  }
}

// ─── Top Shot GraphQL: fetch stats grouped by setID ──────────────────────────

async function fetchStatsForEditions(
  editionKeys: string[]
): Promise<Map<string, EditionStats>> {
  const out = new Map<string, EditionStats>()

  // Group by setID — one request per set
  const bySet = new Map<string, Array<{ key: string; playID: string }>>()

  for (const key of editionKeys) {
    const parts = key.split("::")[0].split(":")
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue
    const [setID, playID] = parts
    const group = bySet.get(setID) ?? []
    group.push({ key, playID })
    bySet.set(setID, group)
  }

  console.log(
    `[market-feed] Fetching ${editionKeys.length} editions across ${bySet.size} sets`
  )

  const DELAY_MS = 250

  for (const [setID, plays] of bySet.entries()) {
    try {
      const data = await topshotGraphql<TopShotEditionStatsResponse>(
        `
        query GetEditionStats($setID: ID!, $first: Int!) {
          searchEditions(input: { setID: $setID, first: $first }) {
            data {
              set { id }
              play { id }
              stats {
                lowestAsk
                averagePrice
                totalSales
                currentBuyNowPrice
              }
            }
          }
        }
        `,
        { setID, first: 250 }
      )

      const editions = data?.searchEditions?.data ?? []

      // Build playID → stats lookup
      const byPlayId = new Map<
        string,
        { lowestAsk: number | null; averagePrice: number | null; totalSales: number }
      >()

      for (const edition of editions) {
        byPlayId.set(edition.play.id, {
          lowestAsk: edition.stats?.lowestAsk ?? null,
          averagePrice: edition.stats?.averagePrice ?? null,
          totalSales: edition.stats?.totalSales ?? 0,
        })
      }

      // Map back to edition keys
      for (const { key, playID } of plays) {
        const stats = byPlayId.get(playID)
        out.set(key, {
          editionKey: key,
          lowAsk: stats?.lowestAsk ?? null,
          bestOffer: null, // not available from searchEditions
          lastSale: stats?.averagePrice ?? null,
          askCount: stats?.lowestAsk !== null ? 1 : 0,
          offerCount: 0,
          saleCount: stats?.totalSales ?? 0,
          source: "topshot-graphql",
          tags: ["live", "cross-wallet"],
        })
      }
    } catch (e) {
      console.warn(
        `[market-feed] Failed fetching setID ${setID}:`,
        e instanceof Error ? e.message : e
      )
    }

    await new Promise((r) => setTimeout(r, DELAY_MS))
  }

  console.log(`[market-feed] Fetched stats for ${out.size}/${editionKeys.length} editions`)
  return out
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Token guard
  if (FEED_TOKEN) {
    const token = req.nextUrl.searchParams.get("token")
    if (token !== FEED_TOKEN) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
  }

  try {
    const editionKeys = await loadEditionKeysFromSupabase()

    if (!editionKeys.length) {
      console.log("[market-feed] No edition keys found in Supabase yet")
      return NextResponse.json([], {
        headers: {
          "Cache-Control": "public, max-age=120, stale-while-revalidate=60",
        },
      })
    }

    const statsMap = await fetchStatsForEditions(editionKeys)

    // Return as array — shape matches ExternalMarketRow in external-market-adapter.ts
    const results = Array.from(statsMap.values())

    console.log(`[market-feed] Returning ${results.length} edition stats`)

    return NextResponse.json(results, {
      headers: {
        // Cache at CDN for 2 minutes, serve stale for 1 minute while revalidating
        "Cache-Control": "public, max-age=120, stale-while-revalidate=60",
      },
    })
  } catch (e) {
    console.error("[market-feed] Fatal error:", e instanceof Error ? e.message : e)
    return NextResponse.json(
      { error: "market-feed failed" },
      { status: 500 }
    )
  }
}

// Also handle POST for cron job pings
export async function POST(req: NextRequest) {
  return GET(req)
}