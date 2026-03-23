import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
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
    parallelID: string | null
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
    parallelSetPlay: {
      setID: string | null
      playID: string | null
      parallelID: string | null
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
                    parallelID
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
                    parallelSetPlay {
                      setID
                      playID
                      parallelID
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
  if (t.includes("FANDOM")) return "FANDOM"
  return "COMMON"
}

// ── Supabase upserts ──────────────────────────────────────────────────────────

async function upsertPlayer(
  collectionId: string,
  stats: any
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
    console.error("[INGEST] upsertPlayer error:", error.message)
    return null
  }

  return data?.id ?? null
}

async function upsertSet(
  collectionId: string,
  set: any,
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
        tier: tier as any,
      },
      { onConflict: "external_id", ignoreDuplicates: false }
    )
    .select("id")
    .single()

  if (error) {
    console.error("[INGEST] upsertSet error:", error.message)
    return null
  }

  return data?.id ?? null
}

async function upsertEdition(
  collectionId: string,
  playerId: string | null,
  setId: string | null,
  tx: SaleTransaction
): Promise<string | null> {
  const moment = tx.moment
  if (!moment?.set?.id || !moment?.play?.id) return null

  // Edition key format: setID:playID — matches wallet-search route format
  // Use parallelSetPlay if available (has explicit setID/playID), else fall back to set.id:play.id
  const psPlay = moment.parallelSetPlay
  const rawSetId = psPlay?.setID ?? moment.set.id
  const rawPlayId = psPlay?.playID ?? moment.play.id
  const externalId = `${rawSetId}:${rawPlayId}`

  const circulations = moment.setPlay?.circulations
  const tier = formatTier(moment.tier)
  const isRetired = moment.setPlay?.flowRetired ?? false

  const { data, error } = await supabaseAdmin
    .from("editions")
    .upsert(
      {
        external_id: externalId,
        collection_id: collectionId,
        player_id: playerId,
        set_id: setId,
        name: `${moment.play.stats?.playerName ?? "Unknown"} — ${moment.set.flowName ?? "Unknown Set"}`,
        tier: tier as any,
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
    console.error("[INGEST] upsertEdition error:", error.message)
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

  // Use insert with ignoreDuplicates — upsert on partitioned tables
  // requires the partition key (sold_at) in the conflict target
  const { error } = await supabaseAdmin.from("sales").insert(
    {
      edition_id: editionId,
      collection_id: collectionId,
      serial_number: serialNumber ?? 0,
      price_usd: price,
      currency: "USD",
      marketplace: "top_shot",
      transaction_hash: tx.txHash,
      sold_at: tx.updatedAt,
    }
  )

  if (error) {
    // Ignore duplicate key violations (already ingested)
    if (error.message.includes("duplicate") || error.code === "23505") {
      return false
    }
    console.error("[INGEST] upsertSale error:", error.message)
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
    recentSales.length >= 10
      ? "HIGH"
      : recentSales.length >= 3
        ? "MEDIUM"
        : "LOW"

  await supabaseAdmin.from("fmv_snapshots").insert({
    edition_id: editionId,
    collection_id: collectionId,
    fmv_usd: Number(median.toFixed(2)),
    floor_price_usd: Number(floor.toFixed(2)),
    confidence: confidence as any,
    sales_count_7d: recentSales.length,
    algo_version: "1.0.0",
  })
}

// ── Main ingestion logic ──────────────────────────────────────────────────────

async function fetchRecentSales(
  limit: number,
  cursor: string | null
): Promise<{ transactions: SaleTransaction[]; nextCursor: string | null }> {
  const data = await topshotGraphql<SearchTransactionsResponse>(
    SEARCH_TRANSACTIONS_QUERY,
    {
      input: {
        sortBy: "UPDATED_AT_DESC",
        searchInput: {
          pagination: {
            cursor: cursor ?? "",
            direction: "RIGHT",
            limit,
          },
        },
      },
    }
  )

  // Log raw structure so we can debug response shape
  console.log("[INGEST] Raw response:", JSON.stringify(data, null, 2).slice(0, 3000))

  const summary =
    data?.searchMarketplaceTransactions?.data?.searchSummary
  const nextCursor = summary?.pagination?.rightCursor ?? null

  const transactions: SaleTransaction[] = []
  const dataField = (summary as any)?.data

  if (Array.isArray(dataField)) {
    for (const block of dataField) {
      if (Array.isArray((block as any)?.data)) {
        transactions.push(...((block as any).data as SaleTransaction[]))
      }
    }
  } else if (dataField && typeof dataField === "object") {
    const block = dataField as any
    if (Array.isArray(block.data)) {
      transactions.push(...(block.data as SaleTransaction[]))
    }
  }

  return { transactions, nextCursor }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  // Auth check — require a secret token to prevent abuse
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const batchSize = Math.min(Number(body.batchSize ?? 50), 200)
    const cursor = body.cursor ?? null

    console.log(`[INGEST] Starting — batchSize=${batchSize}`)

    // Get NBA Top Shot collection ID
    const { data: collections } = await supabaseAdmin
      .from("collections")
      .select("id")
      .eq("slug", "nba_top_shot")
      .single()

    if (!collections?.id) {
      return NextResponse.json(
        { error: "NBA Top Shot collection not found in DB" },
        { status: 500 }
      )
    }

    const collectionId = collections.id

    // Fetch recent sales from Top Shot
    const { transactions, nextCursor } = await fetchRecentSales(
      batchSize,
      cursor
    )

    console.log(`[INGEST] Fetched ${transactions.length} transactions`)

    // Process each transaction
    let salesIngested = 0
    let editionsUpdated = 0
    let errors = 0

    // Track sales per edition for FMV computation
    const editionSalesMap = new Map<string, number[]>()

    for (const tx of transactions) {
      try {
        // Log first transaction to verify field structure
        if (transactions.indexOf(tx) === 0) {
          console.log("[INGEST] Sample tx:", JSON.stringify({
            setId: tx.moment?.set?.id,
            playId: tx.moment?.play?.id,
            setPlayId: tx.moment?.setPlay?.ID,
            parallelSetPlay: tx.moment?.parallelSetPlay,
          }, null, 2))
        }

        const moment = tx.moment
        if (!moment?.play?.stats || !moment?.set) continue

        const price = toNum(tx.price)
        if (!price || price <= 0) continue

        // Upsert player
        const playerId = await upsertPlayer(collectionId, moment.play.stats)

        // Upsert set
        const tier = formatTier(moment.tier)
        const setDbId = await upsertSet(collectionId, moment.set, tier)

        // Upsert edition
        const editionId = await upsertEdition(
          collectionId,
          playerId,
          setDbId,
          tx
        )
        if (!editionId) continue

        editionsUpdated++

        // Upsert sale
        const inserted = await upsertSale(collectionId, editionId, tx)
        if (inserted) salesIngested++

        // Accumulate sales for FMV
        const existing = editionSalesMap.get(editionId) ?? []
        existing.push(price)
        editionSalesMap.set(editionId, existing)
      } catch (err) {
        console.error("[INGEST] Transaction error:", err)
        errors++
      }
    }

    // Compute FMV snapshots for editions with new sales
    let fmvUpdated = 0
    for (const [editionId, sales] of editionSalesMap.entries()) {
      try {
        await upsertFmvSnapshot(collectionId, editionId, sales)
        fmvUpdated++
      } catch (err) {
        console.error("[INGEST] FMV snapshot error:", err)
      }
    }

    const duration = Date.now() - startTime

    console.log(
      `[INGEST] Done — sales=${salesIngested} editions=${editionsUpdated} fmv=${fmvUpdated} errors=${errors} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      salesIngested,
      editionsUpdated,
      fmvUpdated,
      errors,
      nextCursor,
      hasMore: !!nextCursor,
      durationMs: duration,
    })
  } catch (e) {
    console.error("[INGEST] Fatal error:", e)
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Ingestion failed",
      },
      { status: 500 }
    )
  }
}

// Allow GET for easy browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}