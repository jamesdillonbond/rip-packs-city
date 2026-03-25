import { NextRequest, NextResponse } from "next/server"
import { fetchEditionStats, parseEditionKey } from "@/lib/topshot-graphql"

type EditionSalesResult = {
  editionKey: string
  lowestAsk: number | null
  averagePrice: number | null
  salesCount: number
  listingCount: number
  /** True if the edition key could be parsed into setID/playID */
  parsed: boolean
  source: "topshot-graphql" | "unparseable"
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const editionKeys: string[] = Array.isArray(body.editionKeys)
      ? ([
          ...new Set(
            body.editionKeys.filter(
              (x: unknown): x is string =>
                typeof x === "string" && x.length > 0
            )
          ),
        ] as string[])
      : []

    if (!editionKeys.length) {
      return NextResponse.json({ results: [] })
    }

    // Separate parseable from unparseable keys
    const parseable = editionKeys.filter((k) => parseEditionKey(k) !== null)
    const unparseable = editionKeys.filter((k) => parseEditionKey(k) === null)

    // Fetch real data from Top Shot GraphQL
    const statsMap = await fetchEditionStats(parseable)

    const results: EditionSalesResult[] = [
      // Real data for parseable keys
      ...editionKeys
        .filter((k) => parseEditionKey(k) !== null)
        .map((key) => {
          const stats = statsMap.get(key)
          return {
            editionKey: key,
            lowestAsk: stats?.lowestAsk ?? null,
            averagePrice: stats?.averagePrice ?? null,
            salesCount: stats?.salesCount ?? 0,
            listingCount: stats?.listingCount ?? 0,
            parsed: true,
            source: "topshot-graphql" as const,
          }
        }),
      // Null results for unparseable keys (can't query GraphQL without setID/playID)
      ...unparseable.map((key) => ({
        editionKey: key,
        lowestAsk: null,
        averagePrice: null,
        salesCount: 0,
        listingCount: 0,
        parsed: false,
        source: "unparseable" as const,
      })),
    ]

    return NextResponse.json({ results })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "edition-sales failed",
        results: [],
      },
      { status: 500 }
    )
  }
}