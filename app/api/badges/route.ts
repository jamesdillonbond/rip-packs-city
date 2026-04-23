import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl

  const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
  const collection_id = searchParams.get("collection_id") ?? TS_COLLECTION_ID
  const mode     = searchParams.get("mode")     ?? "threestar"
  const season   = searchParams.get("season")   ?? ""
  const parallel = searchParams.get("parallel") ?? ""
  const team     = searchParams.get("team")     ?? ""
  const player   = searchParams.get("player")   ?? ""   // single player (exact, case-insensitive)
  const players  = searchParams.get("players")  ?? ""   // comma-separated list (case-insensitive)
  const league   = searchParams.get("league")   ?? ""
  const sort     = searchParams.get("sort")     ?? "badge_score"
  const dir      = searchParams.get("dir")      ?? "desc"
  const limit    = Math.min(500, parseInt(searchParams.get("limit") ?? "48", 10))
  const offset   = parseInt(searchParams.get("offset") ?? "0", 10)

  const ALLOWED_SORTS = new Set([
    "badge_score", "burn_rate_pct", "lock_rate_pct",
    "low_ask", "avg_sale_price", "player_name", "circulation_count",
  ])
  const sortCol = ALLOWED_SORTS.has(sort) ? sort : "badge_score"
  const sortDir = dir === "asc"

  try {
    // ── Count query ──────────────────────────────────────────────────────────
    let countQ = supabase
      .from("badge_editions")
      .select("*", { count: "exact", head: true })

    // ── Data query ───────────────────────────────────────────────────────────
    let dataQ = supabase
      .from("badge_editions")
      .select("*")
      .order(sortCol, { ascending: sortDir })
      .range(offset, offset + limit - 1)

    // ── Filters (applied to both) ─────────────────────────────────────────────

    // Mode
    function applyMode(q: any) {
      switch (mode) {
        case "threestar":  return q.eq("is_three_star_rookie", true).eq("has_rookie_mint", true)
        case "rookieyear": return q.contains("play_tags", JSON.stringify([{ id: "2dbd4eef-4417-451b-b645-90f02574a401" }]))
        case "debut":      return q.contains("play_tags", JSON.stringify([{ id: "a75e247a-ecbf-45a6-b1be-58bb07a1b651" }]))
        case "rookiemint": return q.contains("set_play_tags", JSON.stringify([{ id: "24d515af-e967-45f5-a30e-11fc96dc2b62" }]))
        case "roty":       return q.contains("play_tags", JSON.stringify([{ id: "34fe8d3f-681a-42df-856a-e98624f95b11" }]))
        case "championship": return q.contains("play_tags", JSON.stringify([{ id: "f197f60a-b502-4386-b0c0-7f4cde8164ff" }]))
        case "blazers":    return q.eq("team_nba_id", "1610612757")
        // NFL All Day modes — match on set_play_tags[].title
        case "rookie_ad":     return q.contains("set_play_tags", JSON.stringify([{ title: "Rookie" }]))
        case "superbowl_ad":  return q.contains("set_play_tags", JSON.stringify([{ title: "Super Bowl" }]))
        case "playoffs_ad":   return q.contains("set_play_tags", JSON.stringify([{ title: "Playoffs" }]))
        case "probowl_ad":    return q.contains("set_play_tags", JSON.stringify([{ title: "Pro Bowl" }]))
        case "firsttd_ad":    return q.contains("set_play_tags", JSON.stringify([{ title: "First Touchdown" }]))
        default:           return q  // "all" — no filter
      }
    }
    countQ = applyMode(countQ).eq("collection_id", collection_id)
    dataQ  = applyMode(dataQ).eq("collection_id", collection_id)

    // Season
    if (season) {
      countQ = countQ.eq("season", season)
      dataQ  = dataQ.eq("season", season)
    }

    // Parallel
    if (parallel !== "") {
      const pid = parseInt(parallel, 10)
      if (!isNaN(pid)) {
        countQ = countQ.eq("parallel_id", pid)
        dataQ  = dataQ.eq("parallel_id", pid)
      }
    }

    // Team
    if (team) {
      countQ = countQ.eq("team_nba_id", team)
      dataQ  = dataQ.eq("team_nba_id", team)
    }

    // League filter — NBA seasons look like "YYYY-YY", WNBA like "YYYY"
    if (league === "NBA") {
      countQ = countQ.like("season", "____-__")
      dataQ  = dataQ.like("season", "____-__")
    } else if (league === "WNBA") {
      countQ = countQ.not("season", "like", "____-__")
      dataQ  = dataQ.not("season", "like", "____-__")
    }

    // Single player (case-insensitive exact match)
    if (player) {
      countQ = countQ.ilike("player_name", player)
      dataQ  = dataQ.ilike("player_name", player)
    }

    // Multiple players (comma-separated — used by wallet badge enrichment)
    // Supabase .in() does exact match so we use .or() with ilike patterns
    if (players && !player) {
      const names = players.split(",").map(n => n.trim()).filter(Boolean)
      if (names.length > 0) {
        // Build OR filter: player_name.ilike.Name1,player_name.ilike.Name2,...
        const orFilter = names.map(n => `player_name.ilike.${n}`).join(",")
        countQ = countQ.or(orFilter)
        dataQ  = dataQ.or(orFilter)
      }
    }

    // ── Execute ──────────────────────────────────────────────────────────────
    const [countResult, dataResult] = await Promise.all([countQ, dataQ])

    if (dataResult.error) throw dataResult.error

    const editions = (dataResult.data ?? []).map((e: any) => {
      // Unified badges array — mirrors what get_edition_badges_unified(edition_id)
      // returns on the Postgres side: play_tags tagged with source 'play',
      // set_play_tags tagged 'set_play'.
      const unifiedBadges = [
        ...(e.play_tags ?? []).map((t: any) => ({ id: t.id, title: t.title, source: "play" })),
        ...(e.set_play_tags ?? []).map((t: any) => ({ id: t.id, title: t.title, source: "set_play" })),
      ]
      const badgeTitles: string[] = unifiedBadges.map(b => b.title)

      const parallelNames: Record<number, string> = {
        0: "Standard", 17: "Blockchain", 18: "Hardcourt", 19: "Hexwave", 20: "Jukebox",
      }

      return {
        ...e,
        badges:           unifiedBadges,
        badge_titles:     badgeTitles,
        parallel_display: parallelNames[e.parallel_id] ?? `Parallel ${e.parallel_id}`,
        price_gap:        e.low_ask != null && e.highest_offer != null
          ? e.low_ask - e.highest_offer : null,
        is_standard:      e.parallel_id === 0,
        tier_display:     (e.tier ?? "").replace("MOMENT_TIER_", "").replace(/^\w/, (c: string) => c.toUpperCase()),
      }
    })

    // Last sync timestamp
    const { data: syncData } = await supabase
      .from("badge_editions")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single()

    return NextResponse.json({
      editions,
      meta: {
        total:    countResult.count ?? 0,
        limit,
        offset,
        mode,
        season:   season || "all",
        parallel: parallel || "all",
        sort:     sortCol,
        dir,
        lastSync: syncData?.updated_at ?? null,
      },
    })
  } catch (err) {
    console.error("[/api/badges]", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    )
  }
}