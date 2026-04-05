import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const SEARCH_USER_MOMENTS_QUERY = `
  query SearchUserMoments($address: String!, $after: String) {
    searchMintedMoments(input: {
      sortBy: ACQUIRED_AT_DES
      filters: { byOwnerDapperID: [$address] }
      searchInput: {
        pagination: { cursor: $after, direction: RIGHT, limit: 50 }
      }
    }) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            ... on MintedMoments {
              size
              data {
                ... on MintedMoment {
                  id
                  flowId
                  flowSerialNumber
                  set { id flowSeriesNumber }
                  play { id }
                  setPlay { setID playID }
                }
              }
            }
          }
        }
      }
    }
  }
`

type MomentNode = {
  id?: string | null
  flowId?: string | null
  flowSerialNumber?: string | null
  set?: { id?: string | null; flowSeriesNumber?: string | null } | null
  play?: { id?: string | null } | null
  setPlay?: { setID?: string | null; playID?: string | null } | null
}

type SearchMintedMomentsResponse = {
  searchMintedMoments?: {
    data?: {
      searchSummary?: {
        pagination?: { rightCursor?: string | null } | null
        data?: {
          size?: number | null
          data?: MomentNode[] | null
        } | null
      } | null
    } | null
  } | null
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { wallet?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const wallet = body.wallet?.trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet field required" }, { status: 400 })
  }

  console.log(`[wallet-backfill] Starting backfill for wallet: ${wallet}`)

  const MAX_PAGES = 500
  const PAGE_DELAY_MS = 2000
  const UPSERT_CHUNK = 200

  let cursor: string | null = null
  let pagesFetched = 0
  let totalFetched = 0
  const allRows: Array<{
    wallet_address: string
    moment_id: string
    edition_key: string
    serial_number: number | null
    fmv_usd: null
    last_seen_at: string
  }> = []

  const now = new Date().toISOString()

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const variables: Record<string, unknown> = { address: wallet }
      if (cursor) variables.after = cursor

      const data = await topshotGraphql<SearchMintedMomentsResponse>(
        SEARCH_USER_MOMENTS_QUERY,
        variables
      )

      const summary = data?.searchMintedMoments?.data?.searchSummary
      const moments = summary?.data?.data ?? []
      const nextCursor = summary?.pagination?.rightCursor ?? null

      pagesFetched++
      totalFetched += moments.length

      console.log(
        `[wallet-backfill] Page ${pagesFetched} fetched ${moments.length} moments (total: ${totalFetched})`
      )

      for (const m of moments) {
        const momentId = m.flowId ?? m.id ?? null
        if (!momentId) continue

        const setID = m.setPlay?.setID ?? null
        const playID = m.setPlay?.playID ?? null
        const editionKey = setID && playID ? `${setID}:${playID}` : ""

        const serial = m.flowSerialNumber ? parseInt(m.flowSerialNumber, 10) : null

        allRows.push({
          wallet_address: wallet,
          moment_id: String(momentId),
          edition_key: editionKey,
          serial_number: Number.isFinite(serial) ? serial : null,
          fmv_usd: null,
          last_seen_at: now,
        })
      }

      // Stop if no more pages
      if (!nextCursor || moments.length === 0) break

      cursor = nextCursor

      // Rate limit delay between pages
      if (page < MAX_PAGES - 1) {
        await sleep(PAGE_DELAY_MS)
      }
    }
  } catch (err) {
    console.error(
      `[wallet-backfill] Error during pagination at page ${pagesFetched}:`,
      err instanceof Error ? err.message : String(err)
    )
    // Continue to upsert whatever we fetched so far
  }

  // Upsert all fetched moments into wallet_moments_cache
  let totalUpserted = 0
  if (allRows.length > 0) {
    for (let i = 0; i < allRows.length; i += UPSERT_CHUNK) {
      const chunk = allRows.slice(i, i + UPSERT_CHUNK)
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,moment_id" })
        .select("moment_id")

      if (error) {
        console.error(`[wallet-backfill] Upsert error at chunk ${Math.floor(i / UPSERT_CHUNK)}:`, error.message)
      }
      totalUpserted += data?.length ?? chunk.length
    }
  }

  console.log(
    `[wallet-backfill] Backfill complete for ${wallet}: ${totalFetched} fetched, ${totalUpserted} upserted, ${pagesFetched} pages`
  )

  return NextResponse.json({
    total_fetched: totalFetched,
    total_upserted: totalUpserted,
    pages_fetched: pagesFetched,
    wallet_address: wallet,
  })
}
