// lib/alldayGraphql.ts
// NFL All Day consumer-facing GraphQL helper.
// Mirrors the pattern in lib/topshot.ts but targets the nflallday.com consumer endpoint.

const ALLDAY_CONSUMER_GRAPHQL_URL = "https://nflallday.com/consumer/graphql"

/** The on-chain collection address for NFL All Day moments. */
export const ALLDAY_COLLECTION_ADDRESS = "0xe4cf4bdc1751c65d"

type GraphQLResponse<T> = {
  data?: T
  errors?: Array<{ message?: string }>
}

/**
 * Execute a GraphQL query against the NFL All Day consumer endpoint.
 * Throws a descriptive error if the response contains an `errors` array.
 */
export async function alldayGraphql<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(ALLDAY_CONSUMER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "sports-collectible-tool/0.1",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  })

  const rawText = await response.text()

  let json: GraphQLResponse<T> | null = null
  try {
    json = JSON.parse(rawText) as GraphQLResponse<T>
  } catch {
    json = null
  }

  if (!response.ok) {
    throw new Error(
      `NFL All Day consumer GraphQL failed with ${response.status}. Response body: ${rawText}`
    )
  }

  if (json?.errors?.length) {
    throw new Error(
      `NFL All Day GraphQL errors: ${json.errors.map((e) => e.message).filter(Boolean).join("; ")}`
    )
  }

  if (!json?.data) {
    throw new Error(
      `NFL All Day consumer GraphQL returned no data. Raw body: ${rawText}`
    )
  }

  return json.data
}

/**
 * Starter query: fetch editions with their series, set, play, and circulation info.
 * Mirrors the Top Shot hierarchy: Series -> Set -> Play -> Edition -> MomentNFT.
 */
export const GET_ALLDAY_EDITIONS = `
  query GetAllDayEditions($first: Int, $after: String) {
    allEditions(first: $first, after: $after) {
      edges {
        node {
          id
          circulationCount
          series {
            name
            number
          }
          set {
            name
          }
          play {
            playerName
            description
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`
