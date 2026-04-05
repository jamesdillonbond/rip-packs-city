import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/**
 * GET /api/collection-moments
 *
 * Server-side paginated collection moments from wallet_moments_cache,
 * enriched with FMV from fmv_snapshots and player metadata from badge_editions.
 * Falls back to Top Shot GQL for moments missing player_name after badge lookup.
 *
 * Query params:
 *   wallet  - Flow address (required)
 *   page    - page number (default 1)
 *   limit   - rows per page (default 50, max 200)
 *   sortBy  - fmv_desc | fmv_asc | serial_asc | price_asc | price_desc | recent (default fmv_desc)
 *   player  - filter by player name (optional, applied post-fetch)
 *   setName - filter by set name (optional, applied post-fetch)
 *   series  - filter by series number (optional, applied post-fetch)
 *   tier    - filter by tier/rarity (optional, applied post-fetch)
 *   minFmv  - minimum FMV filter (optional)
 *   maxFmv  - maximum FMV filter (optional)
 */

const VALID_SORTS = new Set([
  "fmv_desc", "fmv_asc", "serial_asc", "price_asc", "price_desc", "recent",
])

const TOPSHOT_GQL_URL = "https://public-api.nbatopshot.com/graphql"

const GQL_GET_MOMENT = `
  query GetMomentMeta($id: ID!) {
    getMintedMoment(momentId: $id) {
      data {
        play {
          stats { playerName teamAtMoment }
        }
        set { flowName }
        tier
      }
    }
  }
`

type GqlMomentResponse = {
  getMintedMoment?: {
    data?: {
      play?: { stats?: { playerName?: string; teamAtMoment?: string } }
      set?: { flowName?: string }
      tier?: string
    } | null
  } | null
}

async function fetchMomentMetaFromGql(momentId: string): Promise<{
  player_name: string | null
  set_name: string | null
  tier: string | null
} | null> {
  try {
    const res = await fetch(TOPSHOT_GQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sports-collectible-tool/0.1",
      },
      body: JSON.stringify({ query: GQL_GET_MOMENT, variables: { id: momentId } }),
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) {
      console.log("[collection-moments] GQL fetch failed for moment " + momentId + ": HTTP " + res.status)
      return null
    }
    const json = await res.json()
    if (json?.errors) {
      console.log("[collection-moments] GQL errors for moment " + momentId + ": " + JSON.stringify(json.errors).slice(0, 200))
    }
    const data = (json?.data as GqlMomentResponse)?.getMintedMoment?.data
    if (!data) {
      console.log("[collection-moments] GQL returned no data for moment " + momentId)
      return null
    }
    return {
      player_name: data.play?.stats?.playerName ?? null,
      set_name: data.set?.flowName ?? null,
      tier: data.tier ?? null,
    }
  } catch (err) {
    console.log("[collection-moments] GQL exception for moment " + momentId + ": " + (err instanceof Error ? err.message : String(err)))
    return null
  }
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
    const playerFilter = sp.get("player")?.trim().toLowerCase() ?? null
    const setNameFilter = sp.get("setName")?.trim().toLowerCase() ?? null
    const seriesFilter = sp.get("series") ?? null
    const tierFilter = sp.get("tier")?.trim().toLowerCase() ?? null
    const minFmv = sp.get("minFmv") ? parseFloat(sp.get("minFmv")!) : null
    const maxFmv = sp.get("maxFmv") ? parseFloat(sp.get("maxFmv")!) : null

    // Step 1: Fetch ALL wallet moments from cache (needed for accurate counts
    // and for post-enrichment filtering by player/set/tier/series).
    // wallet_moments_cache columns: wallet_address, moment_id, edition_key, fmv_usd, serial_number,
    //   player_name, set_name, tier, series_number, last_seen_at
    let query = (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id, edition_key, fmv_usd, serial_number, player_name, set_name, tier, series_number, acquired_at, last_seen_at", { count: "exact" })
      .eq("wallet_address", wallet)

    // Apply FMV range filters at DB level (these columns exist on wallet_moments_cache)
    if (minFmv !== null && !isNaN(minFmv)) {
      query = query.gte("fmv_usd", minFmv)
    }
    if (maxFmv !== null && !isNaN(maxFmv)) {
      query = query.lte("fmv_usd", maxFmv)
    }

    // Apply sort at DB level for columns on wallet_moments_cache
    switch (sortBy) {
      case "fmv_desc":
      case "price_desc":
        query = query.order("fmv_usd", { ascending: false, nullsFirst: false })
        break
      case "fmv_asc":
      case "price_asc":
        query = query.order("fmv_usd", { ascending: true, nullsFirst: false })
        break
      case "serial_asc":
        query = query.order("serial_number", { ascending: true, nullsFirst: false })
        break
      case "recent":
        query = query.order("last_seen_at", { ascending: false, nullsFirst: false })
        break
      default:
        query = query.order("fmv_usd", { ascending: false, nullsFirst: false })
        break
    }

    // Fetch up to 20000 rows (covers even the largest wallets)
    query = query.limit(20000)

    const { data: cacheRows, error: cacheError, count: exactCount } = await query

    if (cacheError) {
      console.log("[collection-moments] cache query error:", cacheError.message)
      return NextResponse.json({ error: "Database query failed" }, { status: 500 })
    }

    const allRows: any[] = cacheRows ?? []
    if (!allRows.length) {
      return NextResponse.json({
        moments: [],
        total_count: 0,
        page,
        limit,
        total_pages: 0,
      })
    }

    // Step 2: Collect distinct edition_keys and enrich with badge_editions + fmv_snapshots
    const editionKeys = [...new Set(
      allRows.map(function (r: any) { return r.edition_key as string | null }).filter(Boolean)
    )] as string[]

    // Step 2a: Look up editions table to get internal UUIDs for fmv_snapshots join
    const editionMap = new Map<string, string>() // external_id -> uuid
    if (editionKeys.length > 0) {
      const CHUNK = 200
      for (let i = 0; i < editionKeys.length; i += CHUNK) {
        const chunk = editionKeys.slice(i, i + CHUNK)
        const { data: editions } = await (supabaseAdmin as any)
          .from("editions")
          .select("id, external_id")
          .in("external_id", chunk)
        for (const e of (editions ?? [])) {
          editionMap.set(e.external_id, e.id)
        }
      }
    }

    // Step 2b: Fetch latest FMV per edition from fmv_snapshots (includes floor_price_usd for low_ask)
    const fmvMap = new Map<string, { fmv_usd: number; confidence: string; floor_price_usd: number | null }>()
    const internalIds = [...editionMap.values()]
    if (internalIds.length > 0) {
      const CHUNK = 200
      for (let i = 0; i < internalIds.length; i += CHUNK) {
        const chunk = internalIds.slice(i, i + CHUNK)
        const { data: fmvRows } = await (supabaseAdmin as any)
          .from("fmv_snapshots")
          .select("edition_id, fmv_usd, confidence, floor_price_usd")
          .in("edition_id", chunk)
          .order("computed_at", { ascending: false })
        // Keep only the most recent snapshot per edition (ordered desc, first wins)
        for (const row of (fmvRows ?? [])) {
          if (!fmvMap.has(row.edition_id)) {
            fmvMap.set(row.edition_id, {
              fmv_usd: Number(row.fmv_usd),
              confidence: row.confidence,
              floor_price_usd: row.floor_price_usd != null ? Number(row.floor_price_usd) : null,
            })
          }
        }
      }
    }

    // Step 2c: Fetch metadata from editions table (name, tier, series, circulation_count)
    // editions.name format: "Player Name — Set Name"
    // editions.external_id matches wallet_moments_cache.edition_key (e.g. "92:3459")
    const metaMap = new Map<string, {
      player_name: string | null
      set_name: string | null
      tier: string | null
      series_number: number | null
      circulation_count: number | null
    }>()

    // We already fetched editions in Step 2a — reuse editionMap keys to look up metadata
    if (editionKeys.length > 0) {
      const CHUNK = 200
      for (let i = 0; i < editionKeys.length; i += CHUNK) {
        const chunk = editionKeys.slice(i, i + CHUNK)
        const { data: editionRows } = await (supabaseAdmin as any)
          .from("editions")
          .select("external_id, name, tier, series, circulation_count")
          .in("external_id", chunk)
        for (const row of (editionRows ?? [])) {
          // Parse "Player Name — Set Name" from editions.name
          let playerName: string | null = null
          let setName: string | null = null
          if (row.name) {
            const dashIdx = (row.name as string).indexOf(" — ")
            if (dashIdx >= 0) {
              playerName = (row.name as string).slice(0, dashIdx).trim() || null
              setName = (row.name as string).slice(dashIdx + 3).trim() || null
            } else {
              playerName = (row.name as string).trim() || null
            }
          }
          metaMap.set(row.external_id, {
            player_name: playerName,
            set_name: setName,
            tier: row.tier ?? null,
            series_number: row.series != null ? Number(row.series) : null,
            circulation_count: row.circulation_count != null ? Number(row.circulation_count) : null,
          })
        }
      }
    }
    console.log("[collection-moments] editions metadata matched " + metaMap.size + "/" + editionKeys.length + " edition keys")

    // Step 3: Merge enrichment data into rows
    // Priority: cache columns first (populated by wallet-backfill), then editions table fallback
    const enriched = allRows.map(function (row: any) {
      const ek = row.edition_key as string | null
      const internalId = ek ? editionMap.get(ek) : undefined
      const fmvData = internalId ? fmvMap.get(internalId) : undefined
      const meta = ek ? metaMap.get(ek) : undefined

      const fmvUsd = fmvData?.fmv_usd ?? (row.fmv_usd != null ? Number(row.fmv_usd) : null)
      const confidence = fmvData?.confidence ?? null
      const lowAsk = fmvData?.floor_price_usd ?? null

      // Thumbnail: use Top Shot CDN with setID/playID from edition_key
      let thumbnailUrl: string | null = null
      if (ek) {
        const parts = ek.split(":")
        if (parts.length === 2) {
          thumbnailUrl = "https://assets.nbatopshot.com/resize/editions/" + parts[0] + "_" + parts[1] + "/play" + parts[1] + "_capture_Hero_Black_2880_2880_default.jpg?width=100&quality=80"
        }
      }

      return {
        moment_id: row.moment_id,
        edition_key: ek,
        serial_number: row.serial_number != null ? Number(row.serial_number) : null,
        fmv_usd: fmvUsd,
        confidence,
        low_ask: lowAsk,
        player_name: row.player_name ?? meta?.player_name ?? null,
        set_name: row.set_name ?? meta?.set_name ?? null,
        tier: row.tier ?? meta?.tier ?? null,
        series_number: row.series_number ?? meta?.series_number ?? null,
        circulation_count: meta?.circulation_count ?? null,
        thumbnail_url: thumbnailUrl,
        acquired_at: row.acquired_at ?? null,
        last_seen_at: row.last_seen_at ?? null,
      }
    })

    // Step 4: Apply post-fetch filters (player, setName, series, tier)
    let filtered = enriched
    if (playerFilter) {
      filtered = filtered.filter(function (r: any) {
        return r.player_name && (r.player_name as string).toLowerCase().includes(playerFilter)
      })
    }
    if (setNameFilter) {
      filtered = filtered.filter(function (r: any) {
        return r.set_name && (r.set_name as string).toLowerCase().includes(setNameFilter)
      })
    }
    if (seriesFilter) {
      const seriesNum = parseInt(seriesFilter, 10)
      if (!isNaN(seriesNum)) {
        filtered = filtered.filter(function (r: any) { return r.series_number === seriesNum })
      }
    }
    if (tierFilter) {
      filtered = filtered.filter(function (r: any) {
        return r.tier && (r.tier as string).toLowerCase() === tierFilter
      })
    }

    // Re-sort by enriched FMV (fmv_snapshots data may differ from cached fmv_usd)
    // Nulls always sort last regardless of direction
    switch (sortBy) {
      case "fmv_desc":
      case "price_desc":
        filtered.sort(function (a: any, b: any) {
          const av = a.fmv_usd, bv = b.fmv_usd
          if (av == null && bv == null) return 0
          if (av == null) return 1
          if (bv == null) return -1
          return bv - av
        })
        break
      case "fmv_asc":
      case "price_asc":
        filtered.sort(function (a: any, b: any) {
          const av = a.fmv_usd, bv = b.fmv_usd
          if (av == null && bv == null) return 0
          if (av == null) return 1
          if (bv == null) return -1
          return av - bv
        })
        break
      case "serial_asc":
        filtered.sort(function (a: any, b: any) { return (a.serial_number ?? 999999) - (b.serial_number ?? 999999) })
        break
      case "recent":
        filtered.sort(function (a: any, b: any) {
          const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0
          const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0
          return tb - ta
        })
        break
    }

    // Step 5: Paginate
    // Use the exact count from PostgREST headers when no post-fetch filters are active,
    // since the .limit(20000) cap on rows may truncate the in-memory count.
    const hasPostFilters = !!(playerFilter || setNameFilter || seriesFilter || tierFilter)
    const totalCount = hasPostFilters ? filtered.length : (exactCount ?? filtered.length)
    const offset = (page - 1) * limit
    const moments = filtered.slice(offset, offset + limit)

    // Step 6: GQL fallback for moments in current page that are missing player_name.
    // Group by edition_key to avoid duplicate GQL calls for the same edition.
    const missingByEditionKey = new Map<string, number[]>() // edition_key -> indices in moments[]
    for (let i = 0; i < moments.length; i++) {
      const m = moments[i]
      if (!m.player_name && m.moment_id) {
        const key = m.edition_key ?? m.moment_id
        if (!missingByEditionKey.has(key)) {
          missingByEditionKey.set(key, [])
        }
        missingByEditionKey.get(key)!.push(i)
      }
    }

    if (missingByEditionKey.size > 0) {
      console.log("[collection-moments] GQL fallback needed for " + missingByEditionKey.size + " edition keys")
      const gqlCache = new Map<string, { player_name: string | null; set_name: string | null; tier: string | null }>()

      // Fetch GQL data in parallel (max 10 concurrent to avoid rate limits)
      const entries = [...missingByEditionKey.entries()]
      const BATCH = 10
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH)
        const promises = batch.map(function ([editionKey, indices]) {
          // Use first moment_id for this edition_key as the GQL lookup key
          const momentId = moments[indices[0]].moment_id
          return fetchMomentMetaFromGql(momentId).then(function (result) {
            return { editionKey, result }
          })
        })
        const results = await Promise.all(promises)
        for (const { editionKey, result } of results) {
          if (result) {
            gqlCache.set(editionKey, result)
          }
        }
      }

      // Apply GQL results to moments
      let gqlHits = 0
      for (const [editionKey, indices] of missingByEditionKey.entries()) {
        const gqlData = gqlCache.get(editionKey)
        if (!gqlData) continue
        gqlHits++
        for (const idx of indices) {
          if (gqlData.player_name) moments[idx].player_name = gqlData.player_name
          if (gqlData.set_name) moments[idx].set_name = gqlData.set_name
          if (gqlData.tier && !moments[idx].tier) moments[idx].tier = gqlData.tier
        }
      }
      console.log("[collection-moments] GQL fallback resolved " + gqlHits + "/" + missingByEditionKey.size + " edition keys")
    }

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
