/**
 * Top Shot GraphQL client
 *
 * Endpoint: POST https://nbatopshot.com/marketplace/graphql
 * Auth: Public (no key). Cloudflare-protected — requires browser-like headers.
 * Key queries:
 *   - getMarketplaceTransactionEditionStats → lowestAsk, averagePrice, salesCount per edition
 *   - searchMarketplaceTransactions → 90-day comp sales with serial numbers
 */

const TS_GRAPHQL_URL = "https://public-api.nbatopshot.com/graphql"
const REQUEST_TIMEOUT_MS = 12_000
const BROWSER_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type TopShotEditionStats = {
  /** The edition key as passed in — used to correlate back to scope keys */
  editionKey: string
  lowestAsk: number | null
  averagePrice: number | null
  salesCount: number
  /** Number of active listings */
  listingCount: number
}

export type TopShotRecentSale = {
  editionKey: string
  serialNumber: number
  price: number
  soldAt: string
  badges: string[]
}

// ─── Edition stats query ─────────────────────────────────────────────────────

// searchEditions returns market stats for multiple editions in ONE request.
// This avoids per-edition rate limiting by batching all lookups together.
// The input accepts setID + playID filters; we alias each call with a unique key.
const SEARCH_EDITIONS_QUERY = `
  query SearchEditions($setID: ID, $playID: ID, $first: Int!) {
    searchEditions(input: { setID: $setID, playID: $playID, first: $first }) {
      data {
        set { id }
        play { id }
        stats {
          lowestAsk
          averagePrice
          totalSales
          marketplaceFeeSet
        }
        setPlay {
          circulationCount
        }
      }
    }
  }
`

// ─── Recent sales query ───────────────────────────────────────────────────────

// searchMarketplaceTransactions returns individual sales with serial numbers.
// Used for 90-day comp data and special serial isolation.
const RECENT_SALES_QUERY = `
  query GetRecentSales($setID: ID!, $playID: ID!, $first: Int!) {
    searchMarketplaceTransactions(
      input: {
        setID: $setID
        playID: $playID
        first: $first
        sortBy: TRANSACTION_MOMENT_DATE_DESC
      }
    ) {
      data {
        price
        moment {
          flowSerialNumber
          setPlay {
            setID: id
            playID: play { id }
          }
          badges {
            description
          }
        }
        transactionDate
      }
    }
  }
`

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a Top Shot edition key into setID and playID components.
 * Edition keys from the GraphQL API are formatted as "{setID}:{playID}"
 * or may be passed through from the wallet as the raw Top Shot format.
 * We also handle the internal scope key format "{setID}:{playID}::Base".
 */
export function parseEditionKey(editionKey: string): {
  setID: string
  playID: string
} | null {
  // Strip scope key suffix (::Base, ::/99, etc.)
  const stripped = editionKey.split("::")[0].trim()

  // Format: "setID:playID"
  const colonParts = stripped.split(":")
  if (colonParts.length === 2 && colonParts[0] && colonParts[1]) {
    return { setID: colonParts[0].trim(), playID: colonParts[1].trim() }
  }

  return null
}

async function gqlRequest<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    const response = await fetch(TS_GRAPHQL_URL, {
      method: "POST",
      headers: BROWSER_HEADERS,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      console.warn(
        `[topshot-graphql] HTTP ${response.status} for variables:`,
        JSON.stringify(variables)
      )
      return null
    }

    const json = (await response.json()) as { data?: T; errors?: unknown[] }

    if (json.errors?.length) {
      console.warn("[topshot-graphql] GraphQL errors:", JSON.stringify(json.errors))
    }

    return json.data ?? null
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      console.warn("[topshot-graphql] Request timed out for variables:", JSON.stringify(variables))
    } else {
      console.warn("[topshot-graphql] Request failed:", e instanceof Error ? e.message : e)
    }
    return null
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch edition market stats for a batch of edition keys.
 * Returns a Map keyed by the original editionKey string passed in.
 *
 * Strategy: group edition keys by setID, then fetch all plays for that set
 * in ONE request using searchEditions. This collapses 50 requests into
 * however many unique sets are in the wallet — typically 5-15 for a normal
 * collection, well within rate limits.
 */
export async function fetchEditionStats(
  editionKeys: string[]
): Promise<Map<string, TopShotEditionStats>> {
  const out = new Map<string, TopShotEditionStats>()

  // Dedupe and parse
  const keys = Array.from(new Set(editionKeys.filter((k) => k.length > 0)))
  if (!keys.length) return out

  const parseable = keys.flatMap((key) => {
    const parsed = parseEditionKey(key)
    return parsed ? [{ key, ...parsed }] : []
  })

  if (!parseable.length) {
    console.warn("[topshot-graphql] No parseable edition keys from:", keys.slice(0, 5))
    return out
  }

  // Group by setID — one API call per unique set instead of per edition
  const bySet = new Map<string, Array<{ key: string; playID: string }>>()
  for (const { key, setID, playID } of parseable) {
    const group = bySet.get(setID) ?? []
    group.push({ key, playID })
    bySet.set(setID, group)
  }

  console.log(
    `[topshot-graphql] Fetching stats for ${parseable.length} editions across ${bySet.size} sets`
  )

  type SearchEditionsResponse = {
    searchEditions: {
      data: Array<{
        set: { id: string }
        play: { id: string }
        stats: {
          lowestAsk: number | null
          averagePrice: number | null
          totalSales: number | null
        } | null
        setPlay: { circulationCount: number | null } | null
      }>
    }
  }

  // One request per unique setID
  for (const [setID, plays] of bySet.entries()) {
    const data = await gqlRequest<SearchEditionsResponse>(SEARCH_EDITIONS_QUERY, {
      setID,
      playID: plays.length === 1 ? plays[0].playID : undefined,
      first: 250,
    })

    const editions = data?.searchEditions?.data ?? []

    // Build a playID → stats lookup from the response
    const statsByPlayId = new Map<
      string,
      { lowestAsk: number | null; averagePrice: number | null; totalSales: number }
    >()

    for (const edition of editions) {
      statsByPlayId.set(edition.play.id, {
        lowestAsk: edition.stats?.lowestAsk ?? null,
        averagePrice: edition.stats?.averagePrice ?? null,
        totalSales: edition.stats?.totalSales ?? 0,
      })
    }

    // Map results back to our edition keys
    for (const { key, playID } of plays) {
      const stats = statsByPlayId.get(playID)
      out.set(key, {
        editionKey: key,
        lowestAsk: stats?.lowestAsk ?? null,
        averagePrice: stats?.averagePrice ?? null,
        salesCount: stats?.totalSales ?? 0,
        listingCount: 0, // not available in searchEditions
      })
    }

    // Small delay between set-level requests (not per-edition)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  console.log(`[topshot-graphql] Stats fetched for ${out.size} editions`)
  return out
}


/**
 * Fetch recent sales for a single edition (up to `limit` most recent).
 * Used for 90-day comp data and special serial isolated comps.
 */
export async function fetchRecentSales(
  editionKey: string,
  limit = 30
): Promise<TopShotRecentSale[]> {
  const parsed = parseEditionKey(editionKey)
  if (!parsed) return []

  type SalesResponse = {
    searchMarketplaceTransactions: {
      data: Array<{
        price: number
        transactionDate: string
        moment: {
          flowSerialNumber: number
          badges: Array<{ description: string }>
        }
      }>
    }
  }

  const data = await gqlRequest<SalesResponse>(RECENT_SALES_QUERY, {
    setID: parsed.setID,
    playID: parsed.playID,
    first: limit,
  })

  const raw = data?.searchMarketplaceTransactions?.data ?? []

  return raw.map((item) => ({
    editionKey,
    serialNumber: item.moment.flowSerialNumber,
    price: item.price,
    soldAt: item.transactionDate,
    badges: item.moment.badges.map((b) => b.description).filter(Boolean),
  }))
}

/**
 * Fetch edition stats and convert directly to UnifiedEditionMarket shape.
 * This is the main entry point for market-sources.ts.
 */
export type GraphQLMarketData = {
  lowAsk: number | null
  bestOffer: number | null
  lastSale: number | null
  askCount: number
  offerCount: number
  saleCount: number
  source: string
  sourceChain: string[]
  notes: string[]
  tags: string[]
}

export async function fetchEditionMarketMap(
  editionKeys: string[]
): Promise<Map<string, GraphQLMarketData>> {
  const statsMap = await fetchEditionStats(editionKeys)
  const out = new Map<string, GraphQLMarketData>()

  for (const [key, stats] of statsMap.entries()) {
    const hasData = stats.lowestAsk !== null || stats.salesCount > 0

    out.set(key, {
      lowAsk: stats.lowestAsk,
      bestOffer: null, // GraphQL stats don't include best offer — comes from live row aggregate
      lastSale: stats.averagePrice, // avg price used as last-sale proxy until 90d comp is wired
      askCount: stats.listingCount,
      offerCount: 0,
      saleCount: stats.salesCount,
      source: "topshot-graphql",
      sourceChain: ["topshot-graphql"],
      notes: hasData ? [] : ["No market data found for this edition"],
      tags: hasData ? ["graphql", "live"] : ["graphql", "no-data"],
    })
  }

  return out
}