// app/api/edition-sales/route.ts
//
// Per-edition sales stats. Phase 2: accepts an optional collectionId in the
// POST body. Only Top Shot has a live GraphQL stats source today — other
// collections return parsed:false results rather than invented numbers. We
// deliberately don't invent FMV for AllDay/Golazos/Pinnacle here; the
// collection pages should fall back to Supabase fmv_snapshots for those.

import { NextRequest, NextResponse } from "next/server"
import { fetchEditionStats, parseEditionKey } from "@/lib/topshot-graphql"

type EditionSalesResult = {
  editionKey: string
  lowestAsk: number | null
  averagePrice: number | null
  salesCount: number
  listingCount: number
  parsed: boolean
  source: "topshot-graphql" | "unparseable" | "collection-not-supported"
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const collectionId: string = typeof body?.collectionId === "string" ? body.collectionId : "nba-top-shot"
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
      return NextResponse.json({ results: [], collectionId })
    }

    // Only Top Shot has the GraphQL edition stats path today. For other
    // collections, return unparseable-ish results so the UI can fall back to
    // Supabase fmv_snapshots + cached_listings without blowing up.
    if (collectionId !== "nba-top-shot") {
      const results: EditionSalesResult[] = editionKeys.map((key) => ({
        editionKey: key,
        lowestAsk: null,
        averagePrice: null,
        salesCount: 0,
        listingCount: 0,
        parsed: false,
        source: "collection-not-supported",
      }))
      return NextResponse.json({ results, collectionId })
    }

    // Top Shot path (unchanged).
    const parseable = editionKeys.filter((k) => parseEditionKey(k) !== null)
    const unparseable = editionKeys.filter((k) => parseEditionKey(k) === null)

    const statsMap = await fetchEditionStats(parseable)

    const results: EditionSalesResult[] = [
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

    return NextResponse.json({ results, collectionId })
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
