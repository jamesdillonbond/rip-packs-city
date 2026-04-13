import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/topshot"
import { getCollection } from "@/lib/collections"

/**
 * GET /api/collection-moments
 *
 * Server-side paginated collection moments from wallet_moments_cache,
 * joined with editions + fmv_snapshots in a single SQL query so that
 * ORDER BY fmv_usd DESC happens BEFORE pagination.
 *
 * Uses the Postgres function get_wallet_moments_with_fmv() which joins:
 *   wallet_moments_cache → editions (on external_id = edition_key)
 *                        → fmv_snapshots (on edition_id = editions.id, latest per edition)
 *
 * Query params:
 *   wallet  - Flow address (required)
 *   page    - page number (default 1)
 *   limit   - rows per page (default 50, max 200)
 *   sortBy  - fmv_desc | fmv_asc | serial_asc | price_asc | price_desc | recent (default fmv_desc)
 *   player  - filter by player name (optional)
 *   series  - filter by series number (optional)
 *   tier    - filter by tier/rarity (optional)
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

function isWalletAddress(value: string): boolean {
  return value.startsWith("0x") && value.length === 18
}

type UsernameProfileResponse = {
  getUserProfileByUsername?: {
    publicInfo?: {
      flowAddress?: string | null
    } | null
  } | null
}

async function resolveWalletAddress(input: string): Promise<string> {
  const trimmed = input.trim()
  if (isWalletAddress(trimmed)) return trimmed

  const cleanedUsername = trimmed.replace(/^@+/, "")
  const query = `
    query GetUserProfileByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress }
      }
    }
  `
  const data = await topshotGraphql<UsernameProfileResponse>(query, { username: cleanedUsername })
  const rawWallet = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
  if (!rawWallet) throw new Error("Could not resolve username to wallet address.")
  return rawWallet.startsWith("0x") ? rawWallet : `0x${rawWallet}`
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const walletInput = sp.get("wallet")
    if (!walletInput || walletInput.trim() === "") {
      return NextResponse.json({ message: "wallet parameter is required" }, { status: 400 })
    }

    // Resolve username to wallet address if needed
    const wallet = await resolveWalletAddress(walletInput)
    console.log("[collection-moments] resolved wallet input %s → %s", walletInput, wallet)

    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1)
    const limit = Math.min(200, Math.max(1, parseInt(sp.get("limit") ?? "50", 10) || 50))
    const sortBy = VALID_SORTS.has(sp.get("sortBy") ?? "") ? sp.get("sortBy")! : "fmv_desc"
    const playerFilter = sp.get("player")?.trim() || null
    const seriesFilter = sp.get("series") ? parseInt(sp.get("series")!, 10) : null
    const tierFilter = sp.get("tier")?.trim() || null
    const collectionSlug = sp.get("collection")?.trim() || null
    const offset = (page - 1) * limit

    // Resolve collection slug to UUID if provided
    let collectionId: string | null = null
    if (collectionSlug) {
      const collectionObj = getCollection(collectionSlug)
      const contractName = collectionObj?.flowContractName
      if (contractName) {
        const { data: config } = await (supabaseAdmin as any)
          .from("collection_config")
          .select("collection_id")
          .eq("flow_contract_name", contractName)
          .single()
        if (config?.collection_id) collectionId = config.collection_id
      }
    }

    // Single SQL call: joins wallet_moments_cache → editions → fmv_snapshots,
    // sorts by real FMV BEFORE pagination, returns one page + total count.
    const rpcParams: Record<string, any> = {
      p_wallet: wallet,
      p_sort_by: sortBy,
      p_limit: limit,
      p_offset: offset,
      p_player: playerFilter || null,
      p_series: seriesFilter !== null && !isNaN(seriesFilter) ? seriesFilter : null,
      p_tier: tierFilter || null,
    }
    if (collectionId) rpcParams.p_collection_id = collectionId
    console.log("[collection-moments] calling RPC with:", JSON.stringify(rpcParams))

    const { data, error: rpcError } = await (supabaseAdmin as any)
      .rpc("get_wallet_moments_with_fmv", rpcParams)

    console.log("[collection-moments] RPC result data type:", typeof data, "isArray:", Array.isArray(data), "data:", JSON.stringify(data)?.slice(0, 200))

    if (rpcError) {
      console.log("[collection-moments] RPC error:", JSON.stringify(rpcError))
      return NextResponse.json({ error: "Database query failed" }, { status: 500 })
    }

    // PostgREST wraps RETURNS json in an array — unwrap if needed
    const rpcResult = (Array.isArray(data) ? data[0] : data) as { moments: any[]; total_count: number } | null
    const rawMoments: any[] = rpcResult?.moments ?? []
    const totalCount = Number(rpcResult?.total_count ?? 0)

    // Compute total portfolio FMV in parallel (non-blocking for pagination)
    const totalFmvRpcParams: Record<string, any> = { p_wallet: wallet }
    if (collectionId) totalFmvRpcParams.p_collection_id = collectionId

    const totalFmvPromise = (supabaseAdmin as any)
      .rpc("get_wallet_total_fmv", totalFmvRpcParams)
      .then(function (res: any) {
        if (res.error) { console.log("[collection-moments] total_fmv error:", res.error.message); return 0 }
        return res.data ?? 0
      })
      .catch(function () { return 0 })

    // Add thumbnail URLs: prefer RPC thumbnail_url, fall back to edition_key construction, then moment media URL
    const moments = rawMoments.map(function (row: any) {
      let thumbnailUrl: string | null = row.thumbnail_url ?? null
      if (!thumbnailUrl) {
        const ek = row.edition_key as string | null
        if (ek) {
          const parts = ek.split(":")
          if (parts.length === 2) {
            thumbnailUrl = "https://assets.nbatopshot.com/resize/editions/" + parts[0] + "_" + parts[1] + "/play" + parts[1] + "_capture_Hero_Black_2880_2880_default.jpg?width=100&quality=80"
          }
        }
      }
      // Final fallback: moment flow ID media URL (reliable for all Top Shot moments)
      if (!thumbnailUrl && row.moment_id) {
        thumbnailUrl = "https://assets.nbatopshot.com/media/" + row.moment_id + "?width=256"
      }
      return {
        moment_id: row.moment_id,
        edition_key: row.edition_key ?? null,
        serial_number: row.serial_number != null ? Number(row.serial_number) : null,
        fmv_usd: row.fmv_usd != null ? Number(row.fmv_usd) : null,
        confidence: row.confidence ?? null,
        low_ask: row.low_ask != null ? Number(row.low_ask) : null,
        player_name: row.player_name ?? null,
        set_name: row.set_name ?? null,
        team_name: row.team_name ?? null,
        tier: row.tier ?? null,
        series_number: row.series_number != null ? Number(row.series_number) : null,
        circulation_count: row.circulation_count != null ? Number(row.circulation_count) : null,
        thumbnail_url: thumbnailUrl,
        acquired_at: row.acquired_at ?? null,
        last_seen_at: row.last_seen_at ?? null,
        buy_price: row.buy_price != null ? Number(row.buy_price) : null,
        acquisition_method: row.acquisition_method ?? null,
        loan_principal: row.loan_principal != null ? Number(row.loan_principal) : null,
      }
    })

    // GQL fallback for moments in current page missing player_name
    const missingByEditionKey = new Map<string, number[]>()
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

      const entries = [...missingByEditionKey.entries()]
      const BATCH = 10
      for (let i = 0; i < entries.length; i += BATCH) {
        const batch = entries.slice(i, i + BATCH)
        const promises = batch.map(function ([editionKey, indices]) {
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

    const totalFmv = await totalFmvPromise

    return NextResponse.json({
      moments,
      total_count: totalCount,
      total_fmv: Number(totalFmv),
      page,
      limit,
      total_pages: Math.ceil(totalCount / limit),
      wallet,
    })
  } catch (err) {
    console.log("[collection-moments] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
