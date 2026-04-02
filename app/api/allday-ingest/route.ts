import { NextRequest, NextResponse } from "next/server"
import { alldayGraphql } from "@/lib/allday"
import { supabaseAdmin } from "@/lib/supabase"

// ── Types ────────────────────────────────────────────────────────────────────

type SaleTransaction = {
  id: string
  price: number | null
  updatedAt: string | null
  moment: {
    id: string
    editionID: string | null
    serialNumber: number | null
    circulationCount: number | null
    tier: string | null
    playerName: string | null
    teamName?: string | null
    setName?: string | null
    season?: string | null
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
                id
                price
                updatedAt
                moment {
                  id
                  editionID
                  serialNumber
                  circulationCount
                  tier
                  playerName
                  teamName
                  setName
                  season
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
  return "COMMON"
}

function buildEditionKey(tx: SaleTransaction): string | null {
  const editionID = tx.moment?.editionID
  if (!editionID) return null
  return `allday:${editionID}`
}

// ── Supabase upserts ──────────────────────────────────────────────────────────

async function upsertPlayer(
  collectionId: string,
  moment: NonNullable<SaleTransaction["moment"]>
): Promise<string | null> {
  if (!moment.playerName) return null

  const { data, error } = await supabaseAdmin
    .from("players")
    .upsert(
      {
        external_id: `allday:${moment.editionID ?? moment.playerName}`,
        collection_id: collectionId,
        name: moment.playerName,
        team: moment.teamName ?? null,
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

async function upsertEdition(
  collectionId: string,
  playerId: string | null,
  tx: SaleTransaction,
  editionKey: string
): Promise<string | null> {
  const moment = tx.moment
  if (!moment) return null

  const tier = formatTier(moment.tier)

  const { data, error } = await supabaseAdmin
    .from("editions")
    .upsert(
      {
        external_id: editionKey,
        collection_id: collectionId,
        player_id: playerId,
        name: `${moment.playerName ?? "Unknown"} \u2014 ${moment.setName ?? "Unknown Set"}`,
        tier: tier as "COMMON" | "RARE" | "LEGENDARY" | "ULTIMATE",
        series: toNum(moment.season),
        circulation_count: toNum(moment.circulationCount),
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
  if (!tx.id || !tx.price || !tx.updatedAt) return false

  const price = toNum(tx.price)
  if (!price) return false

  const serialNumber = toNum(tx.moment?.serialNumber)
  const nftId = tx.moment?.id ? String(tx.moment.id) : null

  // Write moments row (nft_id is UNIQUE — upsert is safe)
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

  // Write sale row — use tx.id as transaction_hash since All Day
  // doesn't expose a separate txHash field in this query
  const { error } = await supabaseAdmin.from("sales").insert({
    edition_id: editionId,
    collection_id: collectionId,
    serial_number: serialNumber ?? 0,
    price_usd: price,
    currency: "USD",
    marketplace: "nfl_all_day",
    transaction_hash: tx.id,
    sold_at: tx.updatedAt,
    nft_id: nftId,
  })

  if (error) {
    // Duplicate = already ingested, not an error
    if (error.message.includes("duplicate") || error.code === "23505") {
      return false
    }
    console.error("[ALLDAY-INGEST] upsertSale error:", error.message)
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

  // FMV Model v1.1 — same as Top Shot ingest
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

  await supabaseAdmin
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
}

// ── Main ingestion logic ──────────────────────────────────────────────────────

async function fetchRecentSales(
  limit: number,
  cursor: string | null
): Promise<{ transactions: SaleTransaction[]; nextCursor: string | null }> {
  const data = await alldayGraphql<SearchTransactionsResponse>(
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

  const summary = data?.searchMarketplaceTransactions?.data?.searchSummary
  const nextCursor = summary?.pagination?.rightCursor ?? null

  const transactions: SaleTransaction[] = []
  const dataField = summary?.data as unknown

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

  if (transactions.length > 0) {
    const sample = transactions[0]
    console.log("[ALLDAY-INGEST] Sample tx shape:", JSON.stringify({
      txId: sample.id,
      momentId: sample.moment?.id,
      editionID: sample.moment?.editionID ?? "null",
      serialNumber: sample.moment?.serialNumber ?? "null",
      playerName: sample.moment?.playerName ?? "null",
      price: sample.price,
    }))
  } else {
    console.warn("[ALLDAY-INGEST] No transactions in response. Summary keys:", JSON.stringify(Object.keys(summary ?? {})))
    console.warn("[ALLDAY-INGEST] Summary.data type:", typeof dataField, Array.isArray(dataField) ? "array" : "not-array")
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
        if (!moment?.playerName) continue

        const price = toNum(tx.price)
        if (!price || price <= 0) continue

        const editionKey = buildEditionKey(tx)
        if (!editionKey) continue

        // Upsert player, edition
        const playerId = await upsertPlayer(collectionId, moment)
        const editionId = await upsertEdition(collectionId, playerId, tx, editionKey)
        if (!editionId) continue

        editionsUpdated++

        // Insert sale (also writes moments row as a side effect)
        const prevMomentCount = momentsWritten
        const inserted = await upsertSale(collectionId, editionId, tx)

        if (tx.moment?.id && tx.moment?.serialNumber) {
          momentsWritten++
        }

        if (inserted) {
          salesIngested++
        } else {
          if (tx.moment?.id && tx.moment?.serialNumber) {
            momentsWritten = prevMomentCount
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

    // Proactive FMV pass for allday: prefix editions without recent FMV
    let proactiveFmvProcessed = 0
    let proactiveFmvUpdated = 0

    try {
      const { data: alldayEditions } = await supabaseAdmin
        .from("editions")
        .select("id, external_id")
        .like("external_id", "allday:%")

      const candidates = (alldayEditions ?? []).filter((e: { id: string; external_id: string }) => {
        return !editionSalesMap.has(e.id)
      })

      if (candidates.length > 0) {
        console.log(`[ALLDAY-INGEST] Proactive FMV pass: ${candidates.length} allday editions to process`)

        const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        const BATCH_SIZE = 20

        for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
          const batch = candidates.slice(i, i + BATCH_SIZE)
          const batchIds = batch.map((e: { id: string }) => e.id)

          const { data: salesRows } = await supabaseAdmin
            .from("sales")
            .select("edition_id, price_usd")
            .in("edition_id", batchIds)
            .gte("sold_at", windowStart)
            .gt("price_usd", 0)

          if (!salesRows || salesRows.length === 0) continue

          const batchSalesMap = new Map<string, number[]>()
          for (const row of salesRows as { edition_id: string; price_usd: number }[]) {
            const arr = batchSalesMap.get(row.edition_id) ?? []
            arr.push(row.price_usd)
            batchSalesMap.set(row.edition_id, arr)
          }

          for (const [editionId, sales] of batchSalesMap.entries()) {
            try {
              await upsertFmvSnapshot(collectionId, editionId, sales)
              proactiveFmvUpdated++
            } catch {
              // Non-critical
            }
            proactiveFmvProcessed++
          }
        }

        console.log(`[ALLDAY-INGEST] Proactive FMV done: ${proactiveFmvProcessed} processed, ${proactiveFmvUpdated} got fresh FMV snapshots`)
      }
    } catch (err) {
      console.warn("[ALLDAY-INGEST] Proactive FMV pass error:", err instanceof Error ? err.message : String(err))
    }

    const duration = Date.now() - startTime

    console.log(
      `[ALLDAY-INGEST] Done — sales=${salesIngested} dupes=${duplicates} moments=${momentsWritten} editions=${editionsUpdated} fmv=${fmvUpdated} errors=${errors} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      salesIngested,
      momentsWritten,
      duplicates,
      editionsUpdated,
      fmvUpdated,
      proactiveFmvProcessed,
      proactiveFmvUpdated,
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

// Allow GET for browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}
