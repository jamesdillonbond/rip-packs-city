import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { computeFmv, type MarketTruthInput } from "@/lib/market-compute"
import { buildUnifiedEditionMarketMap } from "@/lib/market-sources"
import {
  buildEditionScopeKey,
  normalizeParallel,
  normalizeSetName,
} from "@/lib/wallet-normalize"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const rows: MarketTruthInput[] = Array.isArray(body.rows) ? body.rows : []

    const unifiedMarketMap = await buildUnifiedEditionMarketMap(
      rows.map((row) => ({
        momentId: String(row.momentId),
        editionKey: row.editionKey ?? null,
        setName: row.setName ?? null,
        playerName: row.playerName ?? null,
        parallel: row.parallel ?? null,
        subedition: row.parallel ?? null,
        lowAsk: typeof row.lowAsk === "number" ? row.lowAsk : null,
        bestAsk: typeof row.bestAsk === "number" ? row.bestAsk : null,
        bestOffer: typeof row.bestOffer === "number" ? row.bestOffer : null,
        lastPurchasePrice:
          typeof row.lastPurchasePrice === "number"
            ? row.lastPurchasePrice
            : null,
      }))
    )

    const enriched = rows.map((row) => {
      const scopeKey = buildEditionScopeKey({
        editionKey: row.editionKey ?? null,
        setName: normalizeSetName(row.setName ?? null),
        playerName: row.playerName ?? null,
        parallel: normalizeParallel(row.parallel ?? ""),
        subedition: normalizeParallel(row.parallel ?? ""),
      })

      const editionMarket = unifiedMarketMap.get(scopeKey)

      return computeFmv({
        momentId: String(row.momentId),
        editionKey: row.editionKey ?? null,
        parallel: row.parallel ?? null,
        setName: row.setName ?? null,
        playerName: row.playerName ?? null,
        bestAsk: typeof row.bestAsk === "number" ? row.bestAsk : null,
        lowAsk: typeof row.lowAsk === "number" ? row.lowAsk : null,
        bestOffer: typeof row.bestOffer === "number" ? row.bestOffer : null,
        lastPurchasePrice:
          typeof row.lastPurchasePrice === "number"
            ? row.lastPurchasePrice
            : null,
        editionLowAsk: editionMarket?.lowAsk ?? null,
        editionBestOffer: editionMarket?.bestOffer ?? null,
        editionLastSale: editionMarket?.lastSale ?? null,
        editionAskCount: editionMarket?.askCount ?? 0,
        editionOfferCount: editionMarket?.offerCount ?? 0,
        editionSaleCount: editionMarket?.saleCount ?? 0,
        editionMarketSource: editionMarket?.source ?? null,
        editionMarketSourceChain: editionMarket?.sourceChain ?? [],
        editionMarketTags: editionMarket?.tags ?? [],
        topshotAsk: editionMarket?.topshotAsk ?? null,
        flowtyAsk: editionMarket?.flowtyAsk ?? null,
        fmvUsd: editionMarket?.fmvUsd ?? null,
        fmvConfidence: editionMarket?.fmvConfidence ?? null,
        fmvComputedAt: editionMarket?.fmvComputedAt ?? null,
        specialSerialTraits: Array.isArray(row.specialSerialTraits)
          ? row.specialSerialTraits
          : [],
      })
    })

    return NextResponse.json({ rows: enriched })
  } catch (e) {
    // `rows: []` is deliberately NOT shipped alongside the failure: an empty
    // rows array next to a 500 invites a caller that forgets to check res.ok
    // into rendering "no market data" — a claim about the market — from an
    // internal error. Same call as /api/pack-pulls and /api/edition-sales.
    return apiErrorResponse(e, "api/market-truth");
  }
}