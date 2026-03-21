import { NextRequest, NextResponse } from "next/server";
import { topshotGraphql } from "@/lib/topshot";
import { getFlowtyQuotes } from "@/lib/markets/flowty";
import type { Badge, MarketMoment } from "@/lib/types";

type MintedMomentGraphqlData = {
  getMintedMoment?: {
    data?: {
      id?: string | null;
      flowId?: string | null;
      flowSerialNumber?: string | null;
      price?: number | string | null;
      forSale?: boolean | null;
      lastPurchasePrice?: number | string | null;
      tier?: string | null;
      isLocked?: boolean | null;
      lockExpiryAt?: string | null;
      badges?: Array<{
        type?: string | null;
        iconSvg?: string | null;
      }> | null;
      edition?: {
        id?: string | null;
      } | null;
    } | null;
  } | null;
};

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchTopShotMoment(momentId: string): Promise<MarketMoment> {
  const query = `
    query GetMintedMomentForWalletTool($momentId: ID!) {
      getMintedMoment(momentId: $momentId) {
        data {
          id
          flowId
          flowSerialNumber
          price
          forSale
          lastPurchasePrice
          tier
          isLocked
          lockExpiryAt
          badges {
            type
            iconSvg
          }
          edition {
            id
          }
        }
      }
    }
  `;

  const data = await topshotGraphql<MintedMomentGraphqlData>(query, {
    momentId,
  });

  const moment = data.getMintedMoment?.data;
  const badges: Badge[] = (moment?.badges ?? [])
    .map((badge) => ({
      type: badge.type ?? "UNKNOWN",
      iconSvg: badge.iconSvg ?? "",
    }))
    .filter((badge) => badge.type);

  return {
    momentId,
    flowId: moment?.flowId ?? null,
    flowSerialNumber: toNullableNumber(moment?.flowSerialNumber),
    topshotAsk: moment?.forSale ? toNullableNumber(moment?.price) : null,
    flowtyAsk: null,
    bestAsk: null,
    bestMarket: null,
    lastPurchasePrice: toNullableNumber(moment?.lastPurchasePrice),
    tier: moment?.tier ?? null,
    isLocked: Boolean(moment?.isLocked),
    lockExpiryAt: moment?.lockExpiryAt ?? null,
    badges,
    editionId: moment?.edition?.id ?? null,
    flowtyListingUrl: null,
    updatedAt: null,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { momentIds?: string[] };

    const momentIds = Array.isArray(body.momentIds)
      ? [...new Set(body.momentIds.filter(Boolean))]
      : [];

    if (momentIds.length === 0) {
      return NextResponse.json(
        { error: "momentIds must be a non-empty array." },
        { status: 400 }
      );
    }

    const [topshotResults, flowtyResults] = await Promise.all([
      Promise.all(momentIds.map((momentId) => fetchTopShotMoment(momentId))),
      getFlowtyQuotes(momentIds),
    ]);

    const flowtyMap = Object.fromEntries(
      flowtyResults.map((item) => [item.momentId, item])
    );

    const results: MarketMoment[] = topshotResults.map((item) => {
      const flowty = flowtyMap[item.momentId];
      const flowtyAsk = flowty?.flowtyAsk ?? null;
      const topshotAsk = item.topshotAsk ?? null;

      let bestAsk: number | null = null;
      let bestMarket: "Top Shot" | "Flowty" | null = null;

      if (topshotAsk !== null) {
        bestAsk = topshotAsk;
        bestMarket = "Top Shot";
      }

      if (flowtyAsk !== null && (bestAsk === null || flowtyAsk < bestAsk)) {
        bestAsk = flowtyAsk;
        bestMarket = "Flowty";
      }

      return {
        ...item,
        flowtyAsk,
        bestAsk,
        bestMarket,
        flowtyListingUrl: flowty?.listingUrl ?? null,
        updatedAt: flowty?.updatedAt ?? new Date().toISOString(),
      };
    });

    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch moment market data.",
      },
      { status: 500 }
    );
  }
}