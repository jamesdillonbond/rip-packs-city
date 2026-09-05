import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

// Disney Pinnacle lives in its own tables (pinnacle_sales, pinnacle_editions,
// pinnacle_fmv_snapshots). When `collection=disney-pinnacle` is requested,
// dispatch to the pinnacle_* RPC variants that return the same JSON shapes
// as the shared RPCs. Badge / series analytics don't exist for Pinnacle —
// we return empty arrays to keep the response shape stable for the UI.

const COLLECTION_UUID_MAP = COLLECTION_UUID_BY_SLUG

function periodToDays(period: string): number {
  switch (period) {
    case "7d": return 7
    case "30d": return 30
    case "90d": return 90
    case "ytd": {
      const now = new Date()
      const jan1 = new Date(now.getFullYear(), 0, 1)
      return Math.max(1, Math.ceil((now.getTime() - jan1.getTime()) / 86400000))
    }
    case "all": return 365
    default: return 30
  }
}

function getStartDate(period: string): string {
  const now = new Date()
  switch (period) {
    case "7d":
      return new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10)
    case "30d":
      return new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10)
    case "90d":
      return new Date(now.getTime() - 90 * 86400000).toISOString().slice(0, 10)
    case "ytd":
      return `${now.getFullYear()}-01-01`
    case "all":
      return "2021-01-01"
    default:
      return new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10)
  }
}

export async function GET(req: NextRequest) {
  const collectionSlug = req.nextUrl.searchParams.get("collection") || "nba-top-shot"
  const period = req.nextUrl.searchParams.get("period") || "30d"
  const detail = req.nextUrl.searchParams.get("detail") || "basic"
  const comparison = req.nextUrl.searchParams.get("comparison") === "true"
  const player = req.nextUrl.searchParams.get("player")?.trim() || null

  const collectionId = COLLECTION_UUID_MAP[collectionSlug]
  if (!collectionId) {
    return NextResponse.json({ error: "Unknown collection" }, { status: 400 })
  }

  const isPinnacle = collectionSlug === "disney-pinnacle"
  const startDate = getStartDate(period)
  const startIso = `${startDate}T00:00:00Z`
  const endDate = new Date().toISOString().slice(0, 10)

  try {
    // ── Base time-series via SQL-aggregated RPCs ─────────────────────────
    // Phase 6.5: replaced raw `.from("sales").limit(MAX_ROWS)` reads with
    // get_daily_marketplace_volume() / get_daily_marketplace_volume_pinnacle().
    // The previous approach silently capped at PostgREST's 1000-row default
    // (~1.5 days of TopShot sales) so 30-day breakdowns missed most of the
    // window. The RPCs aggregate server-side and return one row per
    // (day, marketplace).
    const { data: rows, error } = isPinnacle
      ? await (supabaseAdmin as any).rpc("get_daily_marketplace_volume_pinnacle", {
          p_start_iso: startIso,
        })
      : await (supabaseAdmin as any).rpc("get_daily_marketplace_volume", {
          p_collection_id: collectionId,
          p_start_iso: startIso,
        })

    if (error) {
      console.log("[market-analytics] daily RPC error:", error.message)
      return NextResponse.json({ error: "Query failed" }, { status: 500 })
    }

    let totalSales = 0
    let totalVolume = 0
    const daily = (rows || []).map((r: any) => {
      const saleCount = Number(r.sale_count) || 0
      const volume = Number(r.volume_usd) || 0
      totalSales += saleCount
      totalVolume += volume
      return {
        date: r.day,
        marketplace: r.marketplace,
        saleCount,
        volume: Math.round(volume * 100) / 100,
      }
    })

    const body: Record<string, unknown> = {
      period,
      startDate,
      endDate,
      totals: {
        totalSales,
        totalVolume: Math.round(totalVolume * 100) / 100,
      },
      daily,
    }

    // ── Which panels we could not READ, as opposed to which are empty ────
    //
    // 🚨 Every detail panel below used to be published as `res.data ?? []` with
    // its error sent to `console.log` and nowhere else. supabase-js RETURNS
    // errors rather than throwing, so a failed leg resolves `{ data: null,
    // error }`, `?? []` turns it into an empty array, and the response is a
    // confident 200 asserting **"no top sales in this period"** about a query
    // that never ran. That is this repo's most-repeated defect class, twelve
    // times in one route, on the collection analytics page.
    //
    // ⚠ The awareness was already here — someone added a per-leg `console.log`.
    // A lambda console line is not an instrument: nothing alerts on it and no
    // consumer can see it. The response shape simply had nowhere to put the
    // fact, so it went to the one place that could not act on it.
    //
    // `degraded` carries the panel keys whose read FAILED. The arrays stay
    // `?? []` so the response shape is unchanged for every existing consumer —
    // this ADDS a distinction rather than moving one.
    //
    // ⛔ A key appears here ONLY when the read errored. Pinnacle's badge/series
    // panels are legitimately empty (those analytics do not exist for it) and
    // must NOT be listed, or "we could not load this" would replace a true
    // "there is none" — the same defect pointed the other way.
    //
    // ⚠ HALF THE FIX, stated rather than implied. This makes the failure
    // OBSERVABLE; it does not yet change what the reader sees. The client still
    // renders an errored panel as an empty one, because its per-panel copy needs
    // a panel-by-panel reading of which empty states CONCLUDE ("no top sales")
    // versus merely omit. Filed with the panel list rather than guessed at.
    const degraded: string[] = []
    function panel(key: string, res: { data?: unknown; error?: unknown } | null | undefined): unknown[] {
      const err = res?.error as { message?: string } | null | undefined
      if (err) {
        console.log(`[market-analytics] ${key}:`, err.message ?? String(err))
        degraded.push(key)
      }
      return (res?.data as unknown[]) ?? []
    }

    // ── Detail breakdowns (full analytics page) ──────────────────────────
    if (detail === "full") {
      if (isPinnacle) {
        const [topSalesRes, tierRes, topEdRes, dailyTierRes] = await Promise.all([
          (supabaseAdmin as any).rpc("pinnacle_top_sales", {
            p_since: startIso,
            p_limit: 10,
          }),
          (supabaseAdmin as any).rpc("pinnacle_tier_analytics", {
            p_since: startIso,
          }),
          (supabaseAdmin as any).rpc("pinnacle_top_editions", {
            p_since: startIso,
            p_limit: 10,
          }),
          (supabaseAdmin as any).rpc("pinnacle_daily_tier_volume", {
            p_since: startIso,
          }),
        ])

        body.topSales = panel("topSales", topSalesRes)
        body.tierAnalytics = panel("tierAnalytics", tierRes)
        body.topEditions = panel("topEditions", topEdRes)
        body.dailyTierVolume = panel("dailyTierVolume", dailyTierRes)
        // Pinnacle has no badges or NBA-style series — keep shape stable.
        // ⛔ NOT `degraded`: these are MEASURED empties, not failed reads.
        body.badgePremium = []
        body.seriesAnalytics = []
        body.dailySeriesVolume = []
        if (player) body.playerSearch = []
      } else {
        const [topSalesRes, tierRes, topEdRes, dailyTierRes, badgeRes, seriesRes, dailySeriesRes, playerRes] = await Promise.all([
          (supabaseAdmin as any).rpc("get_top_sales", {
            p_collection_id: collectionId,
            p_since: startIso,
            p_limit: 10,
          }),
          (supabaseAdmin as any).rpc("get_tier_analytics", {
            p_collection_id: collectionId,
            p_since: startIso,
          }),
          (supabaseAdmin as any).rpc("get_top_editions", {
            p_collection_id: collectionId,
            p_since: startIso,
            p_limit: 10,
          }),
          (supabaseAdmin as any).rpc("get_daily_tier_volume", {
            p_collection_id: collectionId,
            p_since: startIso,
          }),
          (supabaseAdmin as any).rpc("get_badge_premium", {
            p_collection_id: collectionId,
            p_since: startIso,
          }),
          (supabaseAdmin as any).rpc("get_series_analytics", {
            p_collection_id: collectionId,
            p_since: startIso,
          }),
          (supabaseAdmin as any).rpc("get_daily_series_volume", {
            p_collection_id: collectionId,
            p_since: startIso,
          }),
          player
            ? (supabaseAdmin as any).rpc("search_player_analytics", {
                p_collection_id: collectionId,
                p_player: player,
                p_since: startIso,
                p_limit: 20,
              })
            : Promise.resolve({ data: null, error: null }),
        ])

        body.topSales = panel("topSales", topSalesRes)
        body.tierAnalytics = panel("tierAnalytics", tierRes)
        body.topEditions = panel("topEditions", topEdRes)
        body.dailyTierVolume = panel("dailyTierVolume", dailyTierRes)
        body.badgePremium = panel("badgePremium", badgeRes)
        body.seriesAnalytics = panel("seriesAnalytics", seriesRes)
        body.dailySeriesVolume = panel("dailySeriesVolume", dailySeriesRes)
        // ⚠ Only when a player was actually searched — an unsearched panel is
        // absent, not failed, and `playerRes` is undefined in that case.
        if (player) body.playerSearch = panel("playerSearch", playerRes)
      }
    }

    // ── Period comparison (current vs. prior window) ─────────────────────
    if (comparison) {
      const days = periodToDays(period)
      const cmpRes = isPinnacle
        ? await (supabaseAdmin as any).rpc("pinnacle_period_comparison", { p_days: days })
        : await (supabaseAdmin as any).rpc("get_period_comparison", {
            p_collection_id: collectionId,
            p_days: days,
          })
      if (cmpRes.error) {
        console.log("[market-analytics] period_comparison:", cmpRes.error.message)
        // Already honest on its own — `null` is not a number, so no consumer can
        // read a failed comparison as a measured one. Listed in `degraded` too so
        // one field answers "what could we not read", rather than a caller having
        // to know that this panel signals failure differently from the others.
        body.periodComparison = null
        degraded.push("periodComparison")
      } else {
        body.periodComparison = cmpRes.data ?? null
      }
    }

    // Always present, so `degraded.length === 0` is a POSITIVE statement that
    // every panel we attempted was read — not merely the absence of a key.
    body.degraded = degraded

    const response = NextResponse.json(body)

    response.headers.set(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=120"
    )

    return response
  } catch (err) {
    console.log("[market-analytics] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
