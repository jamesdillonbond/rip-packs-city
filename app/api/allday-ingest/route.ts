import { NextRequest, NextResponse } from "next/server"
import { alldayGraphql } from "@/lib/allday"
import { supabaseAdmin } from "@/lib/supabase"

// ── Types ────────────────────────────────────────────────────────────────────

type SaleTransaction = {
  id: string
  price: number | null
  updatedAt: string | null
  txHash: string | null
  moment: {
    id: string
    flowId: string | null
    flowSerialNumber: string | null
    tier: string | null
    isLocked: boolean | null
    set: {
      id: string
      flowName: string | null
      flowSeriesNumber: number | null
    } | null
    setPlay: {
      ID: string
      flowRetired: boolean | null
      circulations: {
        circulationCount: number | null
        forSaleByCollectors: number | null
        locked: number | null
      } | null
    } | null
    play: {
      id: string
      stats: {
        playerID: string | null
        playerName: string | null
        firstName: string | null
        lastName: string | null
        jerseyNumber: string | null
        teamAtMoment: string | null
        playCategory: string | null
        dateOfMoment: string | null
      } | null
    } | null
  } | null
}

type SearchTransactionsResponse = {
  searchMarketplaceTransactions?: {
    data?: {
      searchSummary?: {
        pagination?: {
          rightCursor?: string | null
        }
        data?: Array<{
          size?: number
          data?: SaleTransaction[]
        }>
      }
    }
  }
}

// ── GraphQL Query ─────────────────────────────────────────────────────────────

const SEARCH_TRANSACTIONS_QUERY = `
  query IngestRecentSales($input: SearchMarketplaceTransactionsInput!) {
    searchMarketplaceTransactions(input: $input) {
      data {
        searchSummary {
          pagination {
            rightCursor
          }
          data {
            ... on MarketplaceTransactions {
              size
              data {
                ... on MarketplaceTransaction {
                  id
                  price
                  updatedAt
                  txHash
                  moment {
                    id
                    flowId
                    flowSerialNumber
                    tier
                    isLocked
                    set {
                      id
                      flowName
                      flowSeriesNumber
                    }
                    setPlay {
                      ID
                      flowRetired
                      circulations {
                        circulationCount
                        forSaleByCollectors
                        locked
                      }
                    }
                    play {
                      id
                      stats {
                        playerID
                        playerName
                        firstName
                        lastName
                        jerseyNumber
                        teamAtMoment
                        playCategory
                        dateOfMoment
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

// ── Helpers ───────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function formatTier(tier: string | null): string {
  if (!tier) return "COMMON"
  const t = tier.toUpperCase()
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("PREMIUM")) return "RARE"
  return "COMMON"
}

function buildEditionKey(tx: SaleTransaction): string | null {
  const moment = tx.moment
  if (!moment) return null
  const setId = moment.set?.id
  const playId = moment.play?.id
  if (!setId || !playId) return null
  return `${setId}:${playId}`
}

// ── Supabase upserts ──────────────────────────────────────────────────────────

async function upsertPlayer(
  collectionId: string,
  stats: NonNullable<NonNullable<SaleTransaction["moment"]>["play"]>["stats"]
): Promise<string | null> {
  if (!stats?.playerID) return null

  const { data, error } = await supabaseAdmin
    .from("players")
    .upsert(
      {
        external_id: String(stats.playerID),
        collection_id: collectionId,
        name: stats.playerName ?? "Unknown Player",
        first_name: stats.firstName ?? null,
        last_name: stats.lastName ?? null,
        team: stats.teamAtMoment ?? null,
        jersey_number: toNum(stats.jerseyNumber),
      },
      { onConflict: "external_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[ALLDAY-INGEST] upsertPlayer error:", error.message)
    return null
  }

  return data?.id ?? null
}

async function upsertSet(
  collectionId: string,
  set: NonNullable<NonNullable<SaleTransaction["moment"]>["set"]>,
  tier: string
): Promise<string | null> {
  if (!set?.id) return null

  const { data, error } = await supabaseAdmin
    .from("sets")
    .upsert(
      {
        external_id: set.id,
        collection_id: collectionId,
        name: set.flowName ?? "Unknown Set",
        series: toNum(set.flowSeriesNumber),
        tier: tier as "COMMON" | "RARE" | "LEGENDARY" | "ULTIMATE" | "FANDOM",
      },
      { onConflict: "external_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[ALLDAY-INGEST] upsertSet error:", error.message)
    return null
  }

  return data?.id ?? null
}

async function upsertEdition(
  collectionId: string,
  playerId: string | null,
  setId: string | null,
  tx: SaleTransaction,
  editionKey: string
): Promise<string | null> {
  const moment = tx.moment
  if (!moment?.set || !moment?.play) return null

  const circulations = moment.setPlay?.circulations
  const tier = formatTier(moment.tier)
  const isRetired = moment.setPlay?.flowRetired ?? false

  const { data, error } = await supabaseAdmin
    .from("editions")
    .upsert(
      {
        external_id: editionKey,
        collection_id: collectionId,
        player_id: playerId,
        set_id: setId,
        name: `${moment.play.stats?.playerName ?? "Unknown"} — ${moment.set.flowName ?? "Unknown Set"}`,
        tier: tier as "COMMON" | "RARE" | "LEGENDARY" | "ULTIMATE" | "FANDOM",
        series: toNum(moment.set.flowSeriesNumber),
        edition_kind: isRetired ? "LE" : "CC",
        circulation_count: toNum(circulations?.circulationCount),
        play_category: moment.play.stats?.playCategory ?? null,
        game_date: moment.play.stats?.dateOfMoment
          ? moment.play.stats.dateOfMoment.split("T")[0]
          : null,
      },
      { onConflict: "external_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[ALLDAY-INGEST] upsertEdition error:", error.message)
    return null
  }

  return data?.id ?? null
}

async function upsertSale(
  collectionId: string,
  editionId: string,
  tx: SaleTransaction
): Promise<boolean> {
  if (!tx.txHash || !tx.price || !tx.updatedAt) return false

  const price = toNum(tx.price)
  if (!price) return false

  const serialNumber = toNum(tx.moment?.flowSerialNumber)
  const nftId = tx.moment?.flowId ? String(tx.moment.flowId) : null

  // Write moments row
  if (nftId && serialNumber !== null) {
    const { error: momentError } = await supabaseAdmin
      .from("moments")
      .upsert(
        {
          nft_id: nftId,
          edition_id: editionId,
          collection_id: collectionId,
          serial_number: serialNumber,
        },
        { onConflict: "nft_id", ignoreDuplicates: true }
      )

    if (momentError && momentError.code !== "23505") {
      console.error("[ALLDAY-INGEST] upsertMoment error:", momentError.message)
    }
  }

  // Write sale row
  const { error: saleError } = await supabaseAdmin.from("sales").insert({
    edition_id: editionId,
    collection_id: collectionId,
    serial_number: serialNumber ?? 0,
    price_usd: price,
    currency: "USD",
    marketplace: "nfl_all_day",
    transaction_hash: tx.txHash,
    sold_at: tx.updatedAt,
    nft_id: nftId,
  })

  if (saleError) {
    if (saleError.message.includes("duplicate") || saleError.code === "23505") {
      return false
    }
    console.error("[ALLDAY-INGEST] upsertSale error:", saleError.message)
    return false
  }

  return true
}

async function upsertFmvSnapshot(
  collectionId: string,
  editionId: string,
  recentSales: number[]
): Promise<void> {
  if (!recentSales.length) return

  const sorted = [...recentSales].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]

  const floor = sorted[0]
  const confidence =
    recentSales.length >= 5
      ? "HIGH"
      : recentSales.length >= 2
        ? "MEDIUM"
        : "LOW"

  const { error } = await supabaseAdmin
    .from("fmv_snapshots")
    .upsert(
      {
        edition_id: editionId,
        collection_id: collectionId,
        fmv_usd: Number(median.toFixed(2)),
        floor_price_usd: Number(floor.toFixed(2)),
        confidence: confidence as "LOW" | "MEDIUM" | "HIGH",
        sales_count_7d: recentSales.length,
        algo_version: "1.1.0",
      },
      { onConflict: "edition_id", ignoreDuplicates: false }
    )

  if (error) {
    console.error("[ALLDAY-INGEST] FMV snapshot error:", error.message)
  }
}

// ── Main ingestion logic ──────────────────────────────────────────────────────

async function fetchRecentSales(
  limit: number,
  cursor: string | null,
  debug = false
): Promise<{ transactions: SaleTransaction[]; nextCursor: string | null; rawDebug?: unknown }> {
  const variables = {
    input: {
      sortBy: "UPDATED_AT_DESC",
      filters: {},
      searchInput: {
        pagination: {
          cursor: cursor ?? "",
          direction: "RIGHT",
          limit,
        },
      },
    },
  }

  const data = await alldayGraphql<SearchTransactionsResponse>(
    SEARCH_TRANSACTIONS_QUERY,
    variables
  )

  // ── Debug logging: raw response shape ──────────────────────────────────
  console.log("[allday-ingest-debug] top-level keys:", JSON.stringify(data ? Object.keys(data) : null))
  const smt = (data as Record<string, unknown>)?.searchMarketplaceTransactions
  console.log("[allday-ingest-debug] searchMarketplaceTransactions keys:", JSON.stringify(smt ? Object.keys(smt as object) : null))
  const smtData = smt && typeof smt === "object" ? (smt as Record<string, unknown>).data : undefined
  console.log("[allday-ingest-debug] .data keys:", JSON.stringify(smtData ? Object.keys(smtData as object) : null))

  // Log first raw transaction object in full
  const summary = data?.searchMarketplaceTransactions?.data?.searchSummary
  const dataField = summary?.data as unknown
  let firstTx: unknown = null
  if (Array.isArray(dataField) && dataField.length > 0) {
    const block = dataField[0] as { data?: unknown[] }
    if (Array.isArray(block?.data) && block.data.length > 0) {
      firstTx = block.data[0]
    }
  } else if (dataField && typeof dataField === "object" && !Array.isArray(dataField)) {
    const block = dataField as { data?: unknown[] }
    if (Array.isArray(block?.data) && block.data.length > 0) {
      firstTx = block.data[0]
    }
  }
  // If firstTx is still null, the shape may be totally different — log the full nested data
  if (!firstTx) {
    console.log("[allday-ingest-debug] summary?.data raw:", JSON.stringify(dataField)?.slice(0, 2000))
    // Also try direct .data at searchMarketplaceTransactions level
    console.log("[allday-ingest-debug] smtData raw:", JSON.stringify(smtData)?.slice(0, 2000))
  } else {
    console.log("[allday-ingest-debug] firstTransaction:", JSON.stringify(firstTx)?.slice(0, 2000))
  }

  // If debug mode, return raw data for inspection
  if (debug) {
    return { transactions: [], nextCursor: null, rawDebug: data }
  }

  const nextCursor = summary?.pagination?.rightCursor ?? null

  const transactions: SaleTransaction[] = []

  if (Array.isArray(dataField)) {
    for (const block of dataField) {
      const b = block as { data?: SaleTransaction[] }
      if (Array.isArray(b?.data)) {
        transactions.push(...b.data)
      }
    }
  } else if (dataField && typeof dataField === "object") {
    const b = dataField as { data?: SaleTransaction[] }
    if (Array.isArray(b.data)) {
      transactions.push(...b.data)
    }
  }

  return { transactions, nextCursor }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  // Auth — Bearer token
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const batchSize = Math.min(Number(body.batchSize ?? 50), 200)
    const cursor = (body.cursor as string | null) ?? null

    console.log(`[ALLDAY-INGEST] Starting — batchSize=${batchSize} cursor=${cursor ?? "start"}`)

    // Get NFL All Day collection ID
    const { data: collections } = await supabaseAdmin
      .from("collections")
      .select("id")
      .eq("slug", "nfl_all_day")
      .single()

    if (!collections?.id) {
      return NextResponse.json(
        { error: "NFL All Day collection not found in DB" },
        { status: 500 }
      )
    }

    const collectionId = collections.id

    // Fetch recent sales from All Day
    const { transactions, nextCursor } = await fetchRecentSales(batchSize, cursor)

    console.log(`[ALLDAY-INGEST] Fetched ${transactions.length} transactions`)

    let salesIngested = 0
    let momentsWritten = 0
    let editionsUpdated = 0
    let duplicates = 0
    let errors = 0

    // Track sales prices per edition for FMV snapshot computation
    const editionSalesMap = new Map<string, number[]>()

    for (const tx of transactions) {
      try {
        const moment = tx.moment
        if (!moment?.play?.stats || !moment?.set) continue

        const price = toNum(tx.price)
        if (!price || price <= 0) continue

        const editionKey = buildEditionKey(tx)
        if (!editionKey) continue

        // Upsert player, set, edition
        const playerId = await upsertPlayer(collectionId, moment.play.stats)
        const tier = formatTier(moment.tier)
        const setDbId = await upsertSet(collectionId, moment.set, tier)
        const editionId = await upsertEdition(collectionId, playerId, setDbId, tx, editionKey)
        if (!editionId) continue

        editionsUpdated++

        const inserted = await upsertSale(collectionId, editionId, tx)

        if (tx.moment?.flowId && tx.moment?.flowSerialNumber) {
          momentsWritten++
        }

        if (inserted) {
          salesIngested++
        } else {
          if (tx.moment?.flowId && tx.moment?.flowSerialNumber) {
            momentsWritten--
          }
          duplicates++
        }

        // Accumulate prices for FMV
        const arr = editionSalesMap.get(editionId) ?? []
        arr.push(price)
        editionSalesMap.set(editionId, arr)
      } catch (err) {
        console.error("[ALLDAY-INGEST] Transaction error:", err)
        errors++
      }
    }

    // Compute and store FMV snapshots
    let fmvUpdated = 0
    for (const [editionId, sales] of editionSalesMap.entries()) {
      try {
        await upsertFmvSnapshot(collectionId, editionId, sales)
        fmvUpdated++
      } catch (err) {
        console.error("[ALLDAY-INGEST] FMV snapshot error:", err)
      }
    }

    const duration = Date.now() - startTime

    console.log(
      `[ALLDAY-INGEST] Done — sales=${salesIngested} dupes=${duplicates} moments=${momentsWritten} editions=${editionsUpdated} fmv=${fmvUpdated} errors=${errors} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      collection: "nfl_all_day",
      salesIngested,
      momentsWritten,
      duplicates,
      editionsUpdated,
      fmvUpdated,
      errors,
      nextCursor,
      hasMore: !!nextCursor,
      durationMs: duration,
    })
  } catch (e) {
    console.error("[ALLDAY-INGEST] Fatal error:", e)
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Ingestion failed",
      },
      { status: 500 }
    )
  }
}

// Allow GET for browser / debug testing
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && token !== expectedToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const debug = req.nextUrl.searchParams.get("debug") === "1"
  const dry = req.nextUrl.searchParams.get("dry") === "1"
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "50"), 200)
  const cursor = req.nextUrl.searchParams.get("cursor") ?? null

  // ── Debug/dry-run mode: return raw GQL response, skip all Supabase writes ──
  if (debug || dry) {
    try {
      const { rawDebug } = await fetchRecentSales(limit, cursor, true)
      return NextResponse.json({
        mode: "debug-dry-run",
        limit,
        rawGqlResponse: rawDebug,
      })
    } catch (e) {
      return NextResponse.json({
        mode: "debug-dry-run",
        error: e instanceof Error ? e.message : String(e),
      }, { status: 500 })
    }
  }

  // Normal flow — delegate to POST handler
  return POST(req)
}
