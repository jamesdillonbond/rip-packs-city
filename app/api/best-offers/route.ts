import { NextRequest, NextResponse } from "next/server"

type BestOfferResult = {
  momentId: string
  editionKey: string | null
  bestOffer: number | null
  bestOfferSource: "Top Shot Edition" | "Top Shot Serial" | "Flowty Serial" | null
  bestOfferType: "edition" | "serial" | null
}

function hashString(input: string) {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33 + input.charCodeAt(i)) >>> 0
  }
  return hash
}

function round2(value: number) {
  return Number(value.toFixed(2))
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const momentIds = Array.isArray(body.momentIds)
      ? body.momentIds.map((x: unknown) => String(x))
      : []

    const editionKeys = Array.isArray(body.editionKeys) ? body.editionKeys : []

    const results: BestOfferResult[] = momentIds.map((momentId: string, index: number) => {
      const editionKey = editionKeys[index] ?? null
      const seed = hashString(`${momentId}:${editionKey ?? "none"}`)

      const shouldHaveOffer = seed % 4 !== 0
      if (!shouldHaveOffer) {
        return {
          momentId,
          editionKey,
          bestOffer: null,
          bestOfferSource: null,
          bestOfferType: null,
        }
      }

      const offer = round2(1 + ((seed % 2500) / 100))

      const sourceSelector = seed % 3
      const bestOfferSource =
        sourceSelector === 0
          ? "Top Shot Edition"
          : sourceSelector === 1
          ? "Top Shot Serial"
          : "Flowty Serial"

      const bestOfferType =
        bestOfferSource === "Top Shot Edition" ? "edition" : "serial"

      return {
        momentId,
        editionKey,
        bestOffer: offer,
        bestOfferSource,
        bestOfferType,
      }
    })

    return NextResponse.json({ results })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "best-offers failed",
        results: [],
      },
      { status: 500 }
    )
  }
}
