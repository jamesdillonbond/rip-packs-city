import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"

// ── Constants ────────────────────────────────────────────────────────────────

const NBA_TOP_SHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const VALID_YEARS = [2024, 2025] as const

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
    set: { id: string } | null
    setPlay: { ID: string } | null
    parallelSetPlay: {
      setID: string | null
      playID: string | null
    } | null
    play: { id: string } | null
  } | null
}

type SearchTransactionsResponse = {
  searchMarketplaceTransactions?: {
    data?: {
      searchSummary?: {
        pagination?: { rightCursor?: string | null }
        data?: unknown
      }
    }
  }
}

// ── GraphQL Query (trimmed to only fields we need for sales) ─────────────────

const SEARCH_TRANSACTIONS_QUERY = `
  query BackfillSales($input: SearchMarketplaceTransactionsInput!) {
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
                    set { id }
                    setPlay { ID }
                    parallelSetPlay {
                      setID
                      playID
                    }
                    play { id }
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
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

function parseTxs(summary: SearchTransactionsResponse["searchMarketplaceTransactions"]): SaleTransaction[] {
  const dataField = summary?.data?.searchSummary?.data as unknown
  const transactions: SaleTransaction[] = []

  if (Array.isArray(dataField)) {
    for (const block of dataField) {
      const b = block as { data?: SaleTransaction[] }
      if (Array.isArray(b?.data)) transactions.push(...b.data)
    }
  } else if (dataField && typeof dataField === "object") {
    const b = dataField as { data?: SaleTransaction[] }
    if (Array.isArray(b.data)) transactions.push(...b.data)
  }

  return transactions
}

// ── Fetch with date range ────────────────────────────────────────────────────

async function fetchSalesPage(
  limit: number,
  cursor: string | null,
  dateAfter: string,
  dateBefore: string
): Promise<{ transactions: SaleTransaction[]; nextCursor: string | null }> {
  const data = await topshotGraphql<SearchTransactionsResponse>(
    SEARCH_TRANSACTIONS_QUERY,
    {
      input: {
        sortBy: "UPDATED_AT_DESC",
        filters: {
          byUpdatedAt: {
            min: dateAfter,
            max: dateBefore,
          },
        },
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

  const summary = data?.searchMarketplaceTransactions
  const nextCursor = summary?.data?.searchSummary?.pagination?.rightCursor ?? null
  const transactions = parseTxs(summary)

  return { transactions, nextCursor }
}

// ── Edition resolver (bulk lookup) ───────────────────────────────────────────

async function resolveEditionIds(
  editionKeys: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!editionKeys.length) return map

  // Supabase .in() has a 100-item limit per call
  const BATCH = 100
  for (let i = 0; i < editionKeys.length; i += BATCH) {
    const batch = editionKeys.slice(i, i + BATCH)
    const { data } = await supabaseAdmin
      .from("editions")
      .select("id, external_id")
      .in("external_id", batch)

    if (data) {
      for (const row of data as { id: string; external_id: string }[]) {
        map.set(row.external_id, row.id)
      }
    }
  }

  return map
}

// ── Route handler ────────────────────────────────────────────────────────────

async function handleBackfill(req: NextRequest) {
  const startTime = Date.now()

  // Auth — Bearer token (same as main ingest)
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Parse params from query string (GET) or body (POST)
    const url = new URL(req.url)
    let yearParam: string | null = url.searchParams.get("year")
    let limitParam: string | null = url.searchParams.get("limit")
    let offsetParam: string | null = url.searchParams.get("offset")
    let cursorParam: string | null = url.searchParams.get("cursor")

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      yearParam = yearParam ?? (body.year ? String(body.year) : null)
      limitParam = limitParam ?? (body.limit ? String(body.limit) : null)
      offsetParam = offsetParam ?? (body.offset ? String(body.offset) : null)
      cursorParam = cursorParam ?? (body.cursor as string | null) ?? null
    }

    const year = Number(yearParam ?? 2025)
    if (!VALID_YEARS.includes(year as 2024 | 2025)) {
      return NextResponse.json(
        { error: `Invalid year. Must be one of: ${VALID_YEARS.join(", ")}` },
        { status: 400 }
      )
    }

    const limit = Math.min(Math.max(Number(limitParam ?? 500), 1), 1000)
    const offset = Math.max(Number(offsetParam ?? 0), 0)

    const dateAfter = `${year}-01-01T00:00:00Z`
    const dateBefore = `${year}-12-31T23:59:59Z`

    console.log(`[BACKFILL] Starting — year=${year} limit=${limit} offset=${offset} cursor=${cursorParam ?? "start"}`)

    // Fetch page of sales from Top Shot GQL
    // If offset > 0 and no cursor, we need to paginate through offset pages first
    let cursor = cursorParam
    let skipped = 0
    if (offset > 0 && !cursor) {
      // Skip through pages to reach the offset
      const pageSize = Math.min(limit, 500)
      while (skipped < offset) {
        const skipBatch = Math.min(pageSize, offset - skipped)
        const { nextCursor } = await fetchSalesPage(skipBatch, cursor, dateAfter, dateBefore)
        skipped += skipBatch
        cursor = nextCursor
        if (!cursor) break
      }
      console.log(`[BACKFILL] Skipped ${skipped} rows to reach offset=${offset}`)
    }

    const { transactions, nextCursor } = await fetchSalesPage(limit, cursor, dateAfter, dateBefore)

    console.log(`[BACKFILL] Fetched ${transactions.length} transactions for year ${year}`)

    if (!transactions.length) {
      return NextResponse.json({
        ok: true,
        year,
        rows_inserted: 0,
        rows_skipped: 0,
        editions_missing: 0,
        offset,
        nextCursor: null,
        hasMore: false,
        durationMs: Date.now() - startTime,
      })
    }

    // Build edition keys and resolve IDs in bulk
    const txWithKeys: Array<{ tx: SaleTransaction; editionKey: string }> = []
    const uniqueKeys = new Set<string>()

    for (const tx of transactions) {
      const key = buildEditionKey(tx)
      if (!key) continue
      if (!tx.txHash || !tx.price || !tx.updatedAt) continue
      txWithKeys.push({ tx, editionKey: key })
      uniqueKeys.add(key)
    }

    const editionMap = await resolveEditionIds([...uniqueKeys])

    // Prepare rows for bulk insert
    const rows: Array<Record<string, unknown>> = []
    let editionsMissing = 0
    const missingKeys = new Set<string>()

    for (const { tx, editionKey } of txWithKeys) {
      const editionId = editionMap.get(editionKey)
      if (!editionId) {
        editionsMissing++
        missingKeys.add(editionKey)
        continue
      }

      const price = toNum(tx.price)
      if (!price || price <= 0) continue

      const serialNumber = toNum(tx.moment?.flowSerialNumber)
      const nftId = tx.moment?.flowId ? String(tx.moment.flowId) : null

      rows.push({
        edition_id: editionId,
        collection_id: NBA_TOP_SHOT_COLLECTION_ID,
        serial_number: serialNumber ?? 0,
        price_usd: price,
        currency: "USD",
        marketplace: "top_shot",
        transaction_hash: tx.txHash,
        sold_at: tx.updatedAt,
        nft_id: nftId,
        collection: "nba_top_shot",
      })
    }

    // Bulk insert with ON CONFLICT DO NOTHING
    let rowsInserted = 0
    let rowsSkipped = 0

    if (rows.length > 0) {
      // Insert in batches of 200 to stay within Supabase limits
      const INSERT_BATCH = 200
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        const batch = rows.slice(i, i + INSERT_BATCH)
        const { data: insertedData, error } = await (supabaseAdmin as any)
          .from("sales")
          .insert(batch)
          .select("id")

        if (error) {
          // If it's a bulk duplicate error, fall back to individual inserts
          if (error.code === "23505" || error.message?.includes("duplicate")) {
            for (const row of batch) {
              const { error: singleError } = await (supabaseAdmin as any)
                .from("sales")
                .insert(row)

              if (singleError) {
                if (singleError.code === "23505" || singleError.message?.includes("duplicate")) {
                  rowsSkipped++
                } else {
                  console.error("[BACKFILL] Insert error:", singleError.message)
                  rowsSkipped++
                }
              } else {
                rowsInserted++
              }
            }
          } else {
            console.error("[BACKFILL] Batch insert error:", error.message)
            rowsSkipped += batch.length
          }
        } else {
          rowsInserted += insertedData?.length ?? batch.length
        }
      }
    }

    if (missingKeys.size > 0) {
      console.log(`[BACKFILL] ${missingKeys.size} unique edition keys not found in editions table (sample: ${[...missingKeys].slice(0, 5).join(", ")})`)
    }

    const duration = Date.now() - startTime

    console.log(
      `[BACKFILL] Done — year=${year} inserted=${rowsInserted} skipped=${rowsSkipped} editionsMissing=${editionsMissing} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      year,
      rows_inserted: rowsInserted,
      rows_skipped: rowsSkipped,
      editions_missing: editionsMissing,
      offset,
      nextCursor,
      hasMore: !!nextCursor,
      durationMs: duration,
    })
  } catch (e) {
    console.error("[BACKFILL] Fatal error:", e)
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Backfill failed",
      },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) {
  return handleBackfill(req)
}

export async function POST(req: NextRequest) {
  return handleBackfill(req)
}
