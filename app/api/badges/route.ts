import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sanitizeOrIlikeValue } from "@/lib/postgrest-safe"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  console.log(`[badges] start url=${req.nextUrl.pathname}${req.nextUrl.search}`)
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
  // Guard NaN: parseInt("abc") is NaN, and Math.min(500, NaN) / .range(NaN, …)
  // emits "Range: 0-NaN" → PostgREST 400 → this public route 500s instead of
  // serving the default page (the sibling recent-sales/top-sales routes guard
  // this exact class).
  const rawLimit  = parseInt(searchParams.get("limit") ?? "48", 10)
  const limit     = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, rawLimit) : 48
  const rawOffset = parseInt(searchParams.get("offset") ?? "0", 10)
  const offset    = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0

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
      // ⚠ UNIQUE TIEBREAKER (R47). Every column in ALLOWED_SORTS is non-unique —
      // `badge_score` heavily so — and offset-paging a tied ORDER BY lets Postgres
      // return the tied rows in a different order per page, so a collector paging
      // this board sees rows REPEAT on one page and VANISH from another. The
      // duplicates and omissions roughly cancel, so the total count stays right
      // and nothing looks wrong. `id` is the PK (verified against pg_indexes
      // 2026-08-23); `external_id` alone is NOT unique here — the unique index is
      // (external_id, collection_id).
      .order("id", { ascending: true })
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
      // This route is PUBLIC (no auth). Each name is spliced into an `.or()`
      // filter STRING, so strip the PostgREST grammar metacharacters (`()`
      // break the group; `%` is a stray wildcard) before interpolating. The
      // comma split already consumes commas as delimiters.
      const names = players.split(",").map(n => sanitizeOrIlikeValue(n).trim()).filter(Boolean)
      if (names.length > 0) {
        // Build OR filter: player_name.ilike.Name1,player_name.ilike.Name2,...
        const orFilter = names.map(n => `player_name.ilike.${n}`).join(",")
        countQ = countQ.or(orFilter)
        dataQ  = dataQ.or(orFilter)
      }
    }

    // ── Execute ──────────────────────────────────────────────────────────────
    const queryT0 = Date.now()
    const [countResult, dataResult] = await Promise.all([countQ, dataQ])
    console.log(`[badges] data+count query elapsedMs=${Date.now() - queryT0} count=${countResult.count ?? 0} rows=${dataResult.data?.length ?? 0}`)

    if (dataResult.error) throw dataResult.error

    // Top Shot's play_tags mix ~6 real badges with ~25 gameplay descriptors
    // (Jump Shot, Dunk, Block, Steal, ...). Only allowlist the titles that
    // are actually badges; set_play_tags are all real badges and stay unfiltered.
    // Mirrors get_edition_badges_unified — see migration audit_20260524_badge_unified_filter_play_tags.
    const PLAY_TAG_BADGE_TITLES = new Set([
      "topshotdebut",
      "rookieyear",
      "rookiemint",
      "rookiepremiere",
      "mvpyear",
      "championshipyear",
      "rookieoftheyear",
      "allstar",
      "threestarrookie",
    ])
    const isBadgePlayTag = (title: unknown): boolean => {
      if (typeof title !== "string") return false
      const norm = title.toLowerCase().replace(/[^a-z0-9]/g, "")
      return PLAY_TAG_BADGE_TITLES.has(norm)
    }

    const editions = (dataResult.data ?? []).map((e: any) => {
      // Unified badges array — mirrors what get_edition_badges_unified(edition_id)
      // returns on the Postgres side: play_tags tagged with source 'play',
      // set_play_tags tagged 'set_play'.
      const unifiedBadges = [
        ...(e.play_tags ?? [])
          .filter((t: any) => isBadgePlayTag(t?.title))
          .map((t: any) => ({ id: t.id, title: t.title, source: "play" })),
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
    const syncT0 = Date.now()
    const { data: syncData } = await boundedRead(supabase
      .from("badge_editions")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .single(), "api/badges/badge_editions")
    console.log(`[badges] sync query elapsedMs=${Date.now() - syncT0}`)
    console.log(`[badges] done elapsedMs=${Date.now() - startedAt}`)

    return NextResponse.json({
      editions,
      meta: {
        // ⚠ null, not 0, when the COUNT read failed. `dataResult.error` throws
        // a few lines above, but the count is deliberately not fatal — the rows
        // are still worth serving. That makes this the realistic split: the
        // count is the EXPENSIVE half (`count: "exact"` over badge_editions,
        // which is why this route logs its elapsed time at all), so it is the
        // likelier of the two to hit a statement timeout, and it fails by
        // RESOLVING with `{ count: null, error }` rather than throwing.
        //
        // `total` is a pagination contract alongside `limit`/`offset`, so a
        // zero here does not merely understate — it tells a paginating caller
        // there is nothing to page through, while `editions` is non-empty in
        // the same response.
        //
        // ⚠ LATENT, NOT LIVE: the one in-repo consumer reads `json.editions`
        // and ignores `meta.total`. Fixed for the contract, not for an observed
        // surface.
        total:    countResult.error ? null : (countResult.count ?? null),
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
    return apiErrorResponse(err, "badges", "Badges aren't available right now.")
  }
}