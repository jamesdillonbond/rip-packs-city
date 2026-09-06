import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { isUnresolvedIdentifierError, unresolvedIdentifierResponse } from "@/lib/api-error"
import { topshotGraphql } from "@/lib/chains/flow/topshot"
import { isUpstreamDown, noteUpstreamFailure, noteUpstreamSuccess } from "@/lib/upstream/host-circuit"
import { getCollection } from "@/lib/collections"
import { bucketAcquisitionCounts } from "@/lib/analytics/shape"
import { lookupCachedTopShotUsername } from "@/lib/chains/flow/topshot-username-resolve"

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
  "paid_desc", "paid_asc",
])

const TOPSHOT_GQL_URL = "https://public-api.nbatopshot.com/graphql"
const TOPSHOT_GQL_HOST = "public-api.nbatopshot.com"

// How long one observed host failure suppresses the fallback ON THIS INSTANCE.
// Sized against the failure it exists for: this host has been 530/1033 for
// ~36 h, so anything in minutes is equivalent for the outage case, and the
// number that matters is the recovery lag — a fix is picked up within one
// cooldown. 5 min keeps that lag small while removing essentially all of the
// waste, and it needs no deploy to un-stick.
const GQL_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000

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
      // A 5xx/429 is the HOST being unavailable; trip the circuit so the rest of
      // this page (and the next few minutes of requests on this instance) skip
      // the wait. A 4xx is about THIS id, not the host, so it must not trip it —
      // otherwise one bad moment id disables enrichment for everyone.
      if (res.status >= 500 || res.status === 429) noteUpstreamFailure(TOPSHOT_GQL_HOST)
      console.log("[collection-moments] GQL fetch failed for moment " + momentId + ": HTTP " + res.status)
      return null
    }
    noteUpstreamSuccess(TOPSHOT_GQL_HOST)
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
    // Includes the 6 s AbortSignal timeout — the single most expensive shape on
    // this path, and the one a dead host produces.
    noteUpstreamFailure(TOPSHOT_GQL_HOST)
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
  // 2026-09-04: the cached username ladder FIRST (the live host below is dead — see lookupCachedTopShotUsername).
  const cachedWallet = await lookupCachedTopShotUsername(supabaseAdmin as any, cleanedUsername)
  if (cachedWallet) return cachedWallet
  const query = `
    query GetUserProfileByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress }
      }
    }
  `
  let data: UsernameProfileResponse | null = null
  try {
    data = await topshotGraphql<UsernameProfileResponse>(query, { username: cleanedUsername })
  } catch (err) {
    // The live lookup FAILED — that is not "no such username", and it must not
    // read as "check the spelling". Tagged so the outer catch can say so.
    const e = new Error("Username lookup unavailable: " + (err instanceof Error ? err.message : String(err)))
    e.name = "UsernameLookupUnavailable"
    throw e
  }
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
        // ⚠ A failed total is NULL, never 0 — `?? 0` on a failed read is the
        // fabricated-number shape (CLAUDE.md), and the client treats a numeric
        // total as a fact about the wallet (2026-09-06).
        if (res.error) { console.log("[collection-moments] total_fmv error:", res.error.message); return null }
        return res.data ?? null
      })
      .catch(function () { return null })

    // ⚠ STARTED HERE, NOT AT ITS USE SITE, and that is the whole point. The
    // comment at the use site said "Fire get_acquisition_stats in parallel
    // (non-blocking)" while the code `await`ed it AFTER `await totalFmvPromise`
    // — fully sequential. `get_acquisition_stats` measured **6,593 ms mean over
    // 15 calls** in the 71 min to 2026-08-30 05:00Z (pg_stat_statements diffed
    // against the 03:50Z snapshot, so post- not pre-fix), which was being added
    // to a route the same night's work had just brought to ~2 s.
    //
    // Kicking it off alongside the total-FMV read makes the comment true: the
    // two RPCs and the row-shaping now overlap instead of queueing. Errors are
    // still swallowed to null — this panel is decoration, and `acquisitionStats`
    // is rendered only when it is non-null with `total_count > 0`, so a failure
    // hides the panel rather than publishing a zeroed one.
    const acqParams: Record<string, any> = { p_wallet: wallet }
    if (collectionId) acqParams.p_collection_id = collectionId
    const acquisitionStatsPromise = (supabaseAdmin as any)
      .rpc("get_acquisition_stats", acqParams)
      .then(function (res: any) { return res.error ? null : res.data })
      .catch(function (err: unknown) {
        console.log("[collection-moments] acquisition-stats lookup failed:", err instanceof Error ? err.message : String(err))
        return null
      })

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
        acquisition_source: row.acquisition_source ?? null,
        acquisition_confidence: row.acquisition_confidence ?? null,
        loan_principal: row.loan_principal != null ? Number(row.loan_principal) : null,
        source_address: row.source_address ?? null,
        is_locked: row.is_locked === true,
        // Phase 2 serial-adjusted FMV (additive #1/perfect-mint premium estimate).
        serial_fmv: row.serial_fmv ?? null,
        // Cleaned 30d price band {low,high,n} — only present for high-volume
        // LOW/MEDIUM editions (the cohort whose bare "LOW" reads as wrong).
        price_band_30d: row.price_band_30d ?? null,
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
        // ⚠ ONE guard, checked at the TOP OF EVERY BATCH — including the first,
        // which is why there is no separate pre-loop check. An earlier version
        // had both; mutation testing killed the pre-loop one (removing it changed
        // nothing, because this check already fires at i === 0), and a branch no
        // test can kill is a branch that will rot. The per-batch position is the
        // load-bearing part: a 200-row page needs several batches, and without
        // re-checking, a request that learns on batch 1 that the host is dead
        // still pays the full 6 s wall for every remaining batch.
        if (isUpstreamDown(TOPSHOT_GQL_HOST, GQL_CIRCUIT_COOLDOWN_MS)) {
          console.log(
            "[collection-moments] GQL fallback " + (i === 0 ? "SKIPPED" : "ABANDONED after " + i) +
            "/" + entries.length + " edition keys — " + TOPSHOT_GQL_HOST +
            " failed within the last " + GQL_CIRCUIT_COOLDOWN_MS / 1000 + "s on this instance",
          )
          break
        }
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

    // Awaited here; the RPC was DISPATCHED far above, alongside the total-FMV
    // read, so by this point it has been running for the whole row-shaping pass.
    let acquisitionStats: {
      pack_pull_count: number
      marketplace_count: number
      challenge_reward_count: number
      gift_count: number
      trade_count: number
      total_count: number
      locked_count: number
      total_spent: number
    } | null = null
    try {
      const acqRaw = await acquisitionStatsPromise
      if (acqRaw) {
        const result = (Array.isArray(acqRaw) ? acqRaw[0] : acqRaw) as { breakdown?: Array<{ method: string; count: number; total_spent?: number }>; total_moments?: number; total_spent?: number; locked_count?: number }
        const counts = bucketAcquisitionCounts(result?.breakdown)
        acquisitionStats = {
          pack_pull_count: counts.pack_pull,
          marketplace_count: counts.marketplace,
          challenge_reward_count: counts.challenge_reward,
          gift_count: counts.gift,
          trade_count: counts.trade,
          total_count: Number(result?.total_moments ?? 0),
          locked_count: Number(result?.locked_count ?? 0),
          total_spent: Number(result?.total_spent ?? 0),
        }
      }
    } catch (err) {
      console.log("[collection-moments] acquisition-stats lookup failed:", err instanceof Error ? err.message : String(err))
    }

    return NextResponse.json({
      moments,
      total_count: totalCount,
      total_fmv: totalFmv === null ? null : Number(totalFmv),
      page,
      limit,
      total_pages: Math.ceil(totalCount / limit),
      wallet,
      acquisitionStats,
    }, {
      // Short private cache so a background prewarm (WarmupContext) makes the
      // logged-in user's own collection load land a browser-cache HIT on nav.
      headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=60" },
    })
  } catch (err) {
    console.log("[collection-moments] error:", err instanceof Error ? err.message : String(err))
    // 2026-09-04: an unresolvable username is the reader's input, not our
    // outage — the fixed 400 copy (never a 500 "Internal server error" that
    // reads as "the site is broken"), the same contract the sibling wallet
    // routes already publish.
    if (isUnresolvedIdentifierError(err)) return unresolvedIdentifierResponse()
    if (err instanceof Error && err.name === "UsernameLookupUnavailable") {
      // Honest and actionable: we could not ASK, so we do not know. The wallet
      // address always works (no lookup involved).
      return NextResponse.json(
        { error: "Top Shot's username lookup is unavailable right now. Try the wallet address (0x…) instead.", code: "upstream_unavailable", retryable: true },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      )
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
