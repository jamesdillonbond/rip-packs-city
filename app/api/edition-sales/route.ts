import { NextRequest, NextResponse } from "next/server"

type EditionSalesResult = {
  editionKey: string
  lastPurchase: number | null
  asp5: number | null
  asp10: number | null
  asp30d: number | null
  fmvBase: number | null
  confidence: "low" | "medium" | "high"
}

function hashString(input: string) {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash
}

function toRange(seed: number, min: number, max: number) {
  const normalized = (seed % 10000) / 10000
  return min + (max - min) * normalized
}

function round2(value: number) {
  return Number(value.toFixed(2))
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const editionKeys = Array.isArray(body.editionKeys)
      ? [...new Set(body.editionKeys.filter((x: unknown): x is string => typeof x === "string" && x.length > 0))]
      : []

    const results: EditionSalesResult[] = editionKeys.map((editionKey) => {
      const seed = hashString(editionKey)
      const base = toRange(seed, 2, 180)

      const lastPurchase = round2(base)
      const asp5 = round2(base * toRange(seed + 11, 0.94, 1.08))
      const asp10 = round2(base * toRange(seed + 29, 0.92, 1.06))
      const asp30d = round2(base * toRange(seed + 47, 0.88, 1.04))
      const fmvBase = round2((lastPurchase * 0.45) + (asp5 * 0.35) + (asp30d * 0.20))

      const confidenceBucket = seed % 3
      const confidence: "low" | "medium" | "high" =
        confidenceBucket === 0 ? "low" : confidenceBucket === 1 ? "medium" : "high"

      return {
        editionKey,
        lastPurchase,
        asp5,
        asp10,
        asp30d,
        fmvBase,
        confidence,
      }
    })

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