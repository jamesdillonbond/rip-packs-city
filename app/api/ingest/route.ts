import { NextRequest, NextResponse, after } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"

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

function buildEditionKey(tx: SaleTransaction): string | null {
  const moment = tx.moment
  if (!moment) return null
  const psp = moment.parallelSetPlay
  const setId = psp?.setID ?? moment.set?.id
  const playId = psp?.playID ?? moment.play?.id
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
        collection: "nba_top_shot",
        name: stats.playerName ?? "Unknown Player",
        first_name: stats.firstName ?? null,
        last_name: stats.lastName ?? null,
        team: stats.teamAtMoment ?? null,
        jersey_number: toNum(stats.jerseyNumber),
      },
      { onConflict: "external_id,collection_id", ignoreDuplicates: false }
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
      { onConflict: "external_id,collection_id", ignoreDuplicates: false }
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
      { onConflict: "external_id,collection_id", ignoreDuplicates: false }
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
  if (!tx.txHash || !tx.price || !tx.updatedAt) {
    console.error("DB write failed: sale missing required fields", {
      txHash: !!tx.txHash,
      price: tx.price,
      updatedAt: !!tx.updatedAt,
      txId: tx.id,
    })
    return false
  }

  const price = toNum(tx.price)
  if (!price) {
    console.error("DB write failed: price parsed to null/zero", { raw: tx.price, txId: tx.id })
    return false
  }

  const serialNumber = toNum(tx.moment?.flowSerialNumber)
  const nftId = tx.moment?.flowId ? String(tx.moment.flowId) : null

  // ── Write moments row ────────────────────────────────────────────────────
  // moments.nft_id is UNIQUE — upsert is safe.
  // moments.serial_number is NOT NULL — skip if missing.
  // This powers the flowty-sales route's nft_id → edition_id bridge.
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
      console.error("[INGEST] upsertMoment error:", momentError.message)
    }
  }

  // ── Write sale row ────────────────────────────────────────────────────────
  const { error: saleError, status, statusText } = await supabaseAdmin.from("sales").insert({
    edition_id: editionId,
    collection_id: collectionId,
    serial_number: serialNumber ?? 0,
    price_usd: price,
    currency: "USD",
    marketplace: "topshot",
    transaction_hash: tx.txHash,
    sold_at: tx.updatedAt,
    nft_id: nftId,
  })

  if (saleError) {
    // Duplicate = already ingested, not an error
    if (saleError.message.includes("duplicate") || saleError.code === "23505") {
      return false
    }
    console.error("DB write failed:", saleError, { status, statusText, txId: tx.id })
    return false
  }

  console.log(`[INGEST] Sale written OK — txHash=${tx.txHash} price=${price} status=${status}`)
  return true
}

async function upsertFmvSnapshot(
  collectionId: string,
  editionId: string,
  recentSales: number[]
): Promise<void> {
  if (!recentSales.length) return

  // ── FMV Model v1.1 ────────────────────────────────────────────────────────
  // Window: 30-day (sales_count_7d column retained for schema compatibility,
  //   value now reflects 30-day count — rename pending future migration)
  // Confidence thresholds recalibrated for Top Shot's thin market reality:
  //   HIGH   = 5+ sales  (was 10)
  //   MEDIUM = 2–4 sales (was 3–9)
  //   LOW    = 1 sale
  // ─────────────────────────────────────────────────────────────────────────

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

  // fmv_snapshots is a partitioned table with PK (id, computed_at) — upsert
  // with onConflict: "edition_id" 400s because no such unique constraint
  // exists. Delete-then-insert scoped to today keeps history intact while
  // ensuring the 20-min ingest cycle overwrites the current day's row.
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  const { error: delError } = await supabaseAdmin
    .from("fmv_snapshots")
    .delete()
    .eq("edition_id", editionId)
    .gte("computed_at", todayStart.toISOString())

  if (delError) {
    console.error("DB delete failed:", delError)
  }

  const { error } = await supabaseAdmin
    .from("fmv_snapshots")
    .insert({
      edition_id: editionId,
      collection_id: collectionId,
      fmv_usd: Number(median.toFixed(2)),
      floor_price_usd: Number(floor.toFixed(2)),
      confidence: confidence as "LOW" | "MEDIUM" | "HIGH",
      sales_count_7d: recentSales.length,
      algo_version: "1.1.0",
    })

  if (error) {
    console.error("DB write failed:", error)
  }
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
    console.log("[INGEST] Sample tx shape:", JSON.stringify({
      txId: sample.id,
      momentId: sample.moment?.id,
      flowId: sample.moment?.flowId ?? "null",
      serialNumber: sample.moment?.flowSerialNumber ?? "null",
      setId: sample.moment?.set?.id,
      playId: sample.moment?.play?.id,
      psp: sample.moment?.parallelSetPlay,
      price: sample.price,
      txHash: sample.txHash ? "present" : "null",
    }))
  } else {
    console.warn("[INGEST] No transactions in response. Summary keys:", JSON.stringify(Object.keys(summary ?? {})))
    console.warn("[INGEST] Summary.data type:", typeof dataField, Array.isArray(dataField) ? "array" : "not-array")
  }

  return { transactions, nextCursor }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get("chain") === "true"

  // Auth — Bearer token
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const batchSize = Math.min(Number(body.batchSize ?? 50), 200)
  const cursor = (body.cursor as string | null) ?? null

  // Run the full ingest asynchronously so the HTTP response returns inside
  // cron-job.org's 30s timeout even when processing takes longer.
  after(async () => {
    const startTime = Date.now()
    try {

    console.log(`[INGEST] Starting — batchSize=${batchSize} cursor=${cursor ?? "start"}`)
    console.log(`[INGEST] SUPABASE_SERVICE_ROLE_KEY set: ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}, length: ${process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0}`)

    // Get NBA Top Shot collection ID
    const { data: collections } = await supabaseAdmin
      .from("collections")
      .select("id")
      .eq("slug", "nba_top_shot")
      .single()

    if (!collections?.id) {
      console.error("[INGEST] NBA Top Shot collection not found in DB")
      return
    }

    const collectionId = collections.id

    // Fetch recent sales from Top Shot
    const { transactions, nextCursor } = await fetchRecentSales(batchSize, cursor)

    console.log(`[INGEST] Fetched ${transactions.length} transactions`)

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

        // Insert sale (also writes moments row as a side effect)
        const prevMomentCount = momentsWritten
        const inserted = await upsertSale(collectionId, editionId, tx)

        // Detect if a moments row was written by checking flowId presence
        if (tx.moment?.flowId && tx.moment?.flowSerialNumber) {
          momentsWritten++
        }

        if (inserted) {
          salesIngested++
        } else {
          // Duplicate sale — don't double-count moment
          if (tx.moment?.flowId && tx.moment?.flowSerialNumber) {
            momentsWritten = prevMomentCount // revert increment for dupes
          }
          duplicates++
        }

        // Accumulate prices for FMV
        const arr = editionSalesMap.get(editionId) ?? []
        arr.push(price)
        editionSalesMap.set(editionId, arr)
      } catch (err) {
        console.error("[INGEST] Transaction error:", err)
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
        console.error("[INGEST] FMV snapshot error:", err)
      }
    }

    // ── Proactive FMV pass for integer-format pack editions ────────────────
    // Ensures all editions seeded by pack-ev (format "digits:digits") get
    // FMV snapshots computed from their existing sales data, even if they
    // weren't in this ingest batch.
    let proactiveFmvProcessed = 0
    let proactiveFmvUpdated = 0

    try {
      // Find integer-format editions that don't yet have an FMV snapshot
      const { data: intEditions } = await supabaseAdmin
        .from("editions")
        .select("id, external_id")
        .like("external_id", "%:%")
        .not("external_id", "like", "%-%")

      // Filter to true integer-format (digits:digits) and exclude already-processed
      const candidates = (intEditions ?? []).filter((e: { id: string; external_id: string }) => {
        return /^\d+:\d+$/.test(e.external_id) && !editionSalesMap.has(e.id)
      })

      if (candidates.length > 0) {
        console.log(`[INGEST] Proactive FMV pass: ${candidates.length} integer-format editions to process`)

        const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
        const BATCH_SIZE = 20

        for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
          const batch = candidates.slice(i, i + BATCH_SIZE)
          const batchIds = batch.map((e: { id: string }) => e.id)

          // Fetch 30-day sales for this batch of editions
          const { data: salesRows } = await supabaseAdmin
            .from("sales")
            .select("edition_id, price_usd")
            .in("edition_id", batchIds)
            .gte("sold_at", windowStart)
            .gt("price_usd", 0)

          if (!salesRows || salesRows.length === 0) continue

          // Group by edition_id
          const batchSalesMap = new Map<string, number[]>()
          for (const row of salesRows as { edition_id: string; price_usd: number }[]) {
            const arr = batchSalesMap.get(row.edition_id) ?? []
            arr.push(row.price_usd)
            batchSalesMap.set(row.edition_id, arr)
          }

          // Compute and upsert FMV for each edition with sales
          for (const [editionId, sales] of batchSalesMap.entries()) {
            try {
              await upsertFmvSnapshot(collectionId, editionId, sales)
              proactiveFmvUpdated++
            } catch {
              // Non-critical — log and continue
            }
            proactiveFmvProcessed++
          }
        }

        console.log(`[INGEST] Proactive FMV done: ${proactiveFmvProcessed} processed, ${proactiveFmvUpdated} got fresh FMV snapshots`)
      }
    } catch (err) {
      console.warn("[INGEST] Proactive FMV pass error:", err instanceof Error ? err.message : String(err))
    }

    const duration = Date.now() - startTime

    console.log(
      `[INGEST] Done — sales=${salesIngested} dupes=${duplicates} moments=${momentsWritten} editions=${editionsUpdated} fmv=${fmvUpdated} errors=${errors} duration=${duration}ms`
    )

    await fireNextPipelineStep("/api/sales-indexer", chain)
    console.log(
      `[INGEST] Summary — sales=${salesIngested} dupes=${duplicates} moments=${momentsWritten} editions=${editionsUpdated} fmv=${fmvUpdated} proactiveFmv=${proactiveFmvUpdated}/${proactiveFmvProcessed} errors=${errors} nextCursor=${nextCursor ?? "null"} durationMs=${duration}`
    )
    } catch (e) {
      console.error("[INGEST] Fatal error:", e instanceof Error ? e.message : String(e))
    }
  })

  return NextResponse.json({
    ok: true,
    message: "Ingest triggered",
    triggeredAt: new Date().toISOString(),
  })
}

// Allow GET for browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}