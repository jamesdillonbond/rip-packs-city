import { NextRequest, NextResponse } from "next/server"
import {
  buildMarketSnapshot,
  type MarketSnapshot,
  type SnapshotInput,
} from "@/lib/market-analytics"
import { getOrSetCache } from "@/lib/cache"

type ResponseShape = {
  results: MarketSnapshot[]
  error?: string
}

const SNAPSHOT_TTL_MS = 1000 * 60 * 5

function buildCacheKey(item: SnapshotInput) {
  return [
    "market-snapshot",
    String(item.momentId),
    item.editionKey ?? "none",
    item.bestAsk ?? "na",
    item.lastPurchasePrice ?? "na",
    item.specialSerialTraits.join("|"),
  ].join(":")
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const items = Array.isArray(body.items) ? body.items : []

    const cleaned: SnapshotInput[] = items.map((item: any) => ({
      momentId: item.momentId,
      editionKey: item.editionKey ?? null,
      bestAsk:
        item.bestAsk === null || item.bestAsk === undefined
          ? null
          : Number(item.bestAsk),
      lastPurchasePrice:
        item.lastPurchasePrice === null || item.lastPurchasePrice === undefined
          ? null
          : Number(item.lastPurchasePrice),
      specialSerialTraits: Array.isArray(item.specialSerialTraits)
        ? item.specialSerialTraits.filter(
            (x: unknown): x is string => typeof x === "string"
          )
        : [],
    }))

    const results = await Promise.all(
      cleaned.map((item) =>
        getOrSetCache(buildCacheKey(item), SNAPSHOT_TTL_MS, async () =>
          buildMarketSnapshot(item)
        )
      )
    )

    return NextResponse.json({ results } satisfies ResponseShape)
  } catch (e) {
    return NextResponse.json(
      {
        results: [],
        error: e instanceof Error ? e.message : "market-snapshot failed",
      } satisfies ResponseShape,
      { status: 500 }
    )
  }
}