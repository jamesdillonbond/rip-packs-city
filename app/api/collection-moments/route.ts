import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/**
 * GET /api/collection-moments
 *
 * Server-side paginated collection moments from wallet_moments_cache
 * joined with editions, fmv_snapshots, and badge_editions for enrichment.
 *
 * Query params:
 *   wallet  - Flow address (required)
 *   page    - page number (default 1)
 *   limit   - rows per page (default 50, max 200)
 *   sortBy  - fmv_desc | fmv_asc | serial_asc | price_asc | price_desc | recent (default fmv_desc)
 *   player  - filter by player name (optional)
 *   setName - filter by set name (optional)
 *   series  - filter by series number (optional)
 *   tier    - filter by tier/rarity (optional)
 *   minFmv  - minimum FMV filter (optional)
 *   maxFmv  - maximum FMV filter (optional)
 */

const VALID_SORTS = new Set([
  "fmv_desc", "fmv_asc", "serial_asc", "price_asc", "price_desc", "recent",
])

function escSQL(val: string): string {
  return val.replace(/'/g, "''")
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const wallet = sp.get("wallet")
    if (!wallet) {
      return NextResponse.json({ error: "wallet param required" }, { status: 400 })
    }

    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(sp.get("limit") ?? "50", 10) || 50))
    const sortBy = VALID_SORTS.has(sp.get("sortBy") ?? "") ? sp.get("sortBy")! : "fmv_desc"
    const playerFilter = sp.get("player") ?? null
    const setNameFilter = sp.get("setName") ?? null
    const seriesFilter = sp.get("series") ?? null
    const tierFilter = sp.get("tier") ?? null
    const minFmv = sp.get("minFmv") ? parseFloat(sp.get("minFmv")!) : null
    const maxFmv = sp.get("maxFmv") ? parseFloat(sp.get("maxFmv")!) : null

    const offset = (page - 1) * limit

    // Build WHERE clauses
    const whereClauses: string[] = [`wmc.wallet_address = '${escSQL(wallet)}'`]

    if (playerFilter) {
      whereClauses.push(`be.player_name ILIKE '%${escSQL(playerFilter)}%'`)
    }
    if (setNameFilter) {
      whereClauses.push(`be.set_name ILIKE '%${escSQL(setNameFilter)}%'`)
    }
    if (seriesFilter) {
      const seriesNum = parseInt(seriesFilter, 10)
      if (!isNaN(seriesNum)) {
        whereClauses.push(`be.series_number = ${seriesNum}`)
      }
    }
    if (tierFilter) {
      whereClauses.push(`be.tier ILIKE '${escSQL(tierFilter)}'`)
    }
    if (minFmv !== null && !isNaN(minFmv)) {
      whereClauses.push(`COALESCE(fs.fmv_usd, wmc.fmv_usd, 0) >= ${minFmv}`)
    }
    if (maxFmv !== null && !isNaN(maxFmv)) {
      whereClauses.push(`COALESCE(fs.fmv_usd, wmc.fmv_usd, 0) <= ${maxFmv}`)
    }

    const whereSQL = whereClauses.join(" AND ")

    // Determine ORDER BY clause
    let orderSQL: string
    switch (sortBy) {
      case "fmv_asc":
        orderSQL = "COALESCE(fs.fmv_usd, wmc.fmv_usd, 0) ASC NULLS LAST"
        break
      case "serial_asc":
        orderSQL = "wmc.serial_number ASC NULLS LAST"
        break
      case "price_asc":
        orderSQL = "COALESCE(fs.fmv_usd, wmc.fmv_usd, 0) ASC NULLS LAST"
        break
      case "price_desc":
        orderSQL = "COALESCE(fs.fmv_usd, wmc.fmv_usd, 0) DESC NULLS LAST"
        break
      case "recent":
        orderSQL = "wmc.last_seen_at DESC NULLS LAST"
        break
      case "fmv_desc":
      default:
        orderSQL = "COALESCE(fs.fmv_usd, wmc.fmv_usd, 0) DESC NULLS LAST"
        break
    }

    const joinSQL = `
      FROM wallet_moments_cache wmc
      LEFT JOIN editions e ON e.external_id = wmc.edition_key
      LEFT JOIN LATERAL (
        SELECT fmv_usd, confidence, computed_at
        FROM fmv_snapshots
        WHERE edition_id = e.id
        ORDER BY computed_at DESC
        LIMIT 1
      ) fs ON true
      LEFT JOIN badge_editions be ON
        split_part(be.id, '+', 1) = split_part(e.external_id, ':', 1)
        AND split_part(be.id, '+', 2) = split_part(e.external_id, ':', 2)
        AND be.parallel_id = 0
    `

    // Count query for total
    const countSQL = `SELECT COUNT(*)::int AS total_count ${joinSQL} WHERE ${whereSQL}`

    // Data query
    const dataSQL = `
      SELECT
        wmc.moment_id,
        wmc.edition_key,
        wmc.serial_number,
        COALESCE(fs.fmv_usd, wmc.fmv_usd) AS fmv_usd,
        fs.confidence,
        be.player_name,
        be.set_name,
        be.tier,
        be.series_number,
        be.circulation_count,
        'https://assets.nbatopshot.com/media/' || wmc.moment_id || '?width=256' AS thumbnail_url,
        wmc.last_seen_at
      ${joinSQL}
      WHERE ${whereSQL}
      ORDER BY ${orderSQL}
      LIMIT ${limit} OFFSET ${offset}
    `

    // Execute both queries in parallel
    const [countResult, dataResult] = await Promise.all([
      (supabaseAdmin as any).rpc("execute_sql", { query: countSQL }),
      (supabaseAdmin as any).rpc("execute_sql", { query: dataSQL }),
    ])

    if (countResult.error) {
      console.log("[collection-moments] count error:", countResult.error.message)
      return NextResponse.json({ error: "Database query failed: " + countResult.error.message }, { status: 500 })
    }
    if (dataResult.error) {
      console.log("[collection-moments] data error:", dataResult.error.message)
      return NextResponse.json({ error: "Database query failed: " + dataResult.error.message }, { status: 500 })
    }

    const countRows = countResult.data ?? []
    const totalCount = countRows.length > 0 ? parseInt(String(countRows[0].total_count), 10) : 0

    const moments = (dataResult.data ?? []).map(function (row: any) {
      return {
        moment_id: row.moment_id,
        edition_key: row.edition_key,
        serial_number: row.serial_number != null ? Number(row.serial_number) : null,
        fmv_usd: row.fmv_usd != null ? Number(row.fmv_usd) : null,
        confidence: row.confidence ?? null,
        player_name: row.player_name ?? null,
        set_name: row.set_name ?? null,
        tier: row.tier ?? null,
        series_number: row.series_number != null ? Number(row.series_number) : null,
        circulation_count: row.circulation_count != null ? Number(row.circulation_count) : null,
        thumbnail_url: row.thumbnail_url ?? null,
        last_seen_at: row.last_seen_at ?? null,
      }
    })

    return NextResponse.json({
      moments,
      total_count: totalCount,
      page,
      limit,
      total_pages: Math.ceil(totalCount / limit),
    })
  } catch (err) {
    console.log("[collection-moments] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
