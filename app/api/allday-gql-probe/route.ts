import { NextRequest, NextResponse } from "next/server"

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""
  if (token !== "rippackscity2026") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const query = `
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

  try {
    const res = await fetch("https://public-api.nflallday.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "sports-collectible-tool/0.1",
      },
      body: JSON.stringify({
        query,
        variables: {
          input: {
            sortBy: "UPDATED_AT_DESC",
            filters: {},
            searchInput: {
              pagination: {
                cursor: "",
                direction: "RIGHT",
                limit: 3,
              },
            },
          },
        },
      }),
      cache: "no-store",
    })

    const rawText = await res.text()
    let parsed: unknown = null
    try { parsed = JSON.parse(rawText) } catch {}

    return NextResponse.json({
      httpStatus: res.status,
      parsed,
      rawTextSlice: rawText.slice(0, 5000),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
