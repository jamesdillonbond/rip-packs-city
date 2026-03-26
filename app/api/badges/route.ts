/**
 * app/api/badges/route.ts
 * Reads badge data from Supabase.
 * Populate the table by running topshot-badge-sync.js in the browser on nbatopshot.com
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const BADGE = {
  ROOKIE_YEAR:        "2dbd4eef-4417-451b-b645-90f02574a401",
  ROOKIE_PREMIERE:    "0ddb2c58-4385-443b-9c70-239b32cddbd4",
  TOP_SHOT_DEBUT:     "a75e247a-ecbf-45a6-b1be-58bb07a1b651",
  ROOKIE_OF_THE_YEAR: "34fe8d3f-681a-42df-856a-e98624f95b11",
  ROOKIE_MINT:        "24d515af-e967-45f5-a30e-11fc96dc2b62",
}

const TRAIL_BLAZERS_NBA_ID = "1610612757"

const VALID_SORTS = [
  "badge_score", "burn_rate_pct", "lock_rate_pct",
  "low_ask", "avg_sale_price", "circulation_count",
  "burned", "locked", "effective_supply", "updated_at",
  "player_name",
]

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const mode     = searchParams.get("mode") ?? "all"
  const season   = searchParams.get("season") ?? ""
  const parallel = searchParams.get("parallel")        // "0" | "17" | "18" etc
  const team     = searchParams.get("team")            // NBA team ID
  const player   = searchParams.get("player")          // player_id
  const league   = searchParams.get("league")          // "NBA" | "WNBA"
  const limit    = Math.min(parseInt(searchParams.get("limit") ?? "50"), 200)
  const offset   = parseInt(searchParams.get("offset") ?? "0")
  const sortBy   = searchParams.get("sort") ?? "badge_score"
  const sortDir  = searchParams.get("dir") ?? "desc"

  try {
    let query = supabase
      .from("badge_editions")
      .select("*", { count: "exact" })

    // ── Mode filters ──────────────────────────────────────────────────────────
    if (mode === "threestar") {
      query = query
        .eq("is_three_star_rookie", true)
        .eq("has_rookie_mint", true)

    } else if (mode === "blazers") {
      query = query
        .eq("team_nba_id", TRAIL_BLAZERS_NBA_ID)
        .eq("is_three_star_rookie", true)

    } else if (mode === "debut") {
      query = query.contains("play_tags", [{ id: BADGE.TOP_SHOT_DEBUT }])

    } else if (mode === "roty") {
      query = query.contains("play_tags", [{ id: BADGE.ROOKIE_OF_THE_YEAR }])

    } else if (mode === "rookiemint") {
      query = query.eq("has_rookie_mint", true)

    } else if (mode === "rookieyear") {
      query = query.contains("play_tags", [{ id: BADGE.ROOKIE_YEAR }])
    }
    // mode === "all" returns everything with no badge filter

    // ── Additional filters ────────────────────────────────────────────────────
    if (season)   query = query.eq("season", season)
    if (parallel) query = query.eq("parallel_id", parseInt(parallel))
    if (team)     query = query.eq("team_nba_id", team)
    if (player)   query = query.eq("player_id", player)

    // Filter out WNBA by default unless explicitly requested
    if (league === "WNBA") {
      query = query.ilike("season", "%-%-%").not("season", "ilike", "%-__")
      // WNBA seasons are formatted as plain years e.g. "2024", not "2024-25"
      // Better to filter by set_name pattern
      query = query.or("season.eq.2024,season.eq.2025,season.eq.2023,season.eq.2022,season.eq.2021")
    } else if (!league || league === "NBA") {
      // NBA seasons are formatted as "2024-25" — filter out plain year seasons
      query = query.like("season", "____-__")
    }

    // ── Sort & paginate ───────────────────────────────────────────────────────
    const safeSort = VALID_SORTS.includes(sortBy) ? sortBy : "badge_score"
    query = query
      .order(safeSort, { ascending: sortDir === "asc" })
      .order("player_name", { ascending: true }) // stable secondary sort
      .range(offset, offset + limit - 1)

    const { data, error, count } = await query

    if (error) {
      console.error("[badges] Supabase error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // ── Enrich with computed display fields ───────────────────────────────────
    const enriched = (data || []).map((row: any) => ({
      ...row,
      badge_titles: [
        ...(row.play_tags  || []).map((t: any) => t.title),
        ...(row.set_play_tags || []).map((t: any) => t.title),
      ],
      parallel_display: row.parallel_id === 0
        ? "Standard"
        : row.parallel_name || "Standard",
      price_gap: (row.low_ask && row.highest_offer)
        ? parseFloat((row.low_ask - row.highest_offer).toFixed(2))
        : null,
      // Convenience for the frontend
      is_standard: row.parallel_id === 0,
      tier_display: (row.tier || "")
        .replace("MOMENT_TIER_", "")
        .charAt(0) + (row.tier || "").replace("MOMENT_TIER_", "").slice(1).toLowerCase(),
    }))

    return NextResponse.json({
      editions: enriched,
      meta: {
        total: count,
        limit,
        offset,
        mode,
        season:   season || "all",
        parallel: parallel ?? "all",
        sort:     safeSort,
        dir:      sortDir,
        lastSync: enriched[0]?.updated_at ?? null,
      },
    })

  } catch (err) {
    console.error("[badges] Route error:", err)
    return NextResponse.json(
      { error: "Badge route error", detail: String(err) },
      { status: 500 }
    )
  }
}