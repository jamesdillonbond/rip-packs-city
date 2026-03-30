// app/api/moment-offers/route.ts
// Fetches serial-level and edition-level offers for a batch of moments.
// Sources:
//   - Top Shot serial offer:   GetTopOffers with byMomentID
//   - Top Shot edition offer:  GetTopOffers with byEdition
//   - Flowty offer:            derived from Flowty listing valuations (best offer embedded in listing response)
//
// Flowty serial-specific offers require Austin Kline's API — not yet available.
// Until then, we use the Flowty listing's embedded offer data as a proxy.

import { NextResponse } from "next/server";

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://nbatopshot.com",
  Referer: "https://nbatopshot.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
};

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

const GET_TOP_OFFERS_QUERY = `
  query GetTopOffers(
    $byMomentID: String
    $byOfferTypes: [OfferType!]
    $byEdition: EditionsFilterInput
    $limit: Int!
  ) {
    getTopOffers(input: {
      filters: {
        byMomentID: $byMomentID
        byOfferTypes: $byOfferTypes
        byEdition: $byEdition
      }
      limit: $limit
    }) {
      offers {
        price
        offerType
        completed
        purchased
        acceptedAt
      }
      totalCount
    }
  }
`;

interface OfferResult {
  price: string | number;
  offerType: string;
  completed: boolean;
  purchased: boolean;
  acceptedAt: string | null;
}

interface TopOffersResponse {
  data?: {
    getTopOffers?: {
      offers?: OfferResult[];
      totalCount?: number;
    };
  };
  errors?: { message: string }[];
}

function parseOfferPrice(p: string | number | null | undefined): number | null {
  if (p == null) return null;
  const n = typeof p === "string" ? parseFloat(p) : p;
  return isNaN(n) || n <= 0 ? null : n;
}

function extractHighestOffer(offers: OfferResult[]): number | null {
  const active = offers.filter(o => !o.completed && !o.purchased && !o.acceptedAt);
  if (!active.length) return null;
  const prices = active
    .map(o => parseOfferPrice(o.price))
    .filter((p): p is number => p !== null);
  return prices.length > 0 ? Math.max(...prices) : null;
}

async function fetchSerialOffer(momentId: string): Promise<number | null> {
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({
        operationName: "GetTopOffers",
        query: GET_TOP_OFFERS_QUERY,
        variables: { byMomentID: momentId, byOfferTypes: ["Serial"], limit: 5 },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json() as TopOffersResponse;
    if (json.errors?.length) return null;
    return extractHighestOffer(json.data?.getTopOffers?.offers ?? []);
  } catch {
    return null;
  }
}

async function fetchEditionOffer(setID: string, playID: string): Promise<number | null> {
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({
        operationName: "GetTopOffers",
        query: GET_TOP_OFFERS_QUERY,
        variables: { byEdition: { setID, playID }, byOfferTypes: ["Edition"], limit: 1 },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json() as TopOffersResponse;
    if (json.errors?.length) return null;
    return extractHighestOffer(json.data?.getTopOffers?.offers ?? []);
  } catch {
    return null;
  }
}

// Fetch Flowty offer for a specific NFT by flowId.
// Flowty embeds best offer data in the listing response for that NFT.
// We query by nftID filter to get the specific moment's listing + any offers.
async function fetchFlowtyOffer(flowId: string): Promise<number | null> {
  try {
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null,
        addresses: [],
        collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
        from: 0,
        includeAllListings: true,
        limit: 5,
        onlyUnlisted: false,
        orderFilters: [
          {
            conditions: [{ field: "nftID", operator: "eq", value: flowId }],
            kind: "offer",
            paymentTokens: [],
          },
        ],
        sort: { direction: "desc", listingKind: "offer", path: "salePrice" },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const nfts = data.nfts ?? [];
    let best: number | null = null;
    for (const nft of nfts) {
      for (const order of nft.orders ?? []) {
        if (order.kind !== "offer" && order.listingKind !== "offer") continue;
        if (order.state !== "LISTED" && order.state !== "OPEN") continue;
        const price = typeof order.salePrice === "number" ? order.salePrice : parseFloat(order.salePrice);
        if (price > 0 && (best === null || price > best)) best = price;
      }
    }
    return best;
  } catch {
    return null;
  }
}

export interface MomentOfferInput {
  momentId: string;   // Top Shot moment UUID (for serial offer)
  flowId: string;     // Flow NFT ID (for Flowty offer)
  setID: string;      // for edition offer
  playID: string;     // for edition offer
}

export interface MomentOfferResult {
  momentId: string;
  serialOffer: number | null;    // TS offer on this specific serial
  editionOffer: number | null;   // TS highest offer on any serial in the edition
  flowtyOffer: number | null;    // Flowty offer on this specific serial
  bestOffer: number | null;      // max of all three
  bestOfferSource: "ts_serial" | "ts_edition" | "flowty" | null;
}

async function processMoment(input: MomentOfferInput): Promise<MomentOfferResult> {
  const { momentId, flowId, setID, playID } = input;

  // Fire all three in parallel
  const [serialOffer, editionOffer, flowtyOffer] = await Promise.all([
    fetchSerialOffer(momentId),
    fetchEditionOffer(setID, playID),
    fetchFlowtyOffer(flowId),
  ]);

  const candidates: { amount: number; source: MomentOfferResult["bestOfferSource"] }[] = [];
  if (serialOffer !== null) candidates.push({ amount: serialOffer, source: "ts_serial" });
  if (editionOffer !== null) candidates.push({ amount: editionOffer, source: "ts_edition" });
  if (flowtyOffer !== null) candidates.push({ amount: flowtyOffer, source: "flowty" });

  const best = candidates.length > 0
    ? candidates.reduce((a, b) => a.amount >= b.amount ? a : b)
    : null;

  return {
    momentId,
    serialOffer,
    editionOffer,
    flowtyOffer,
    bestOffer: best?.amount ?? null,
    bestOfferSource: best?.source ?? null,
  };
}

export async function POST(req: Request) {
  let moments: MomentOfferInput[] = [];
  try {
    const body = await req.json();
    moments = Array.isArray(body.moments) ? body.moments : [];
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!moments.length) {
    return NextResponse.json({ offers: {} });
  }

  // Cap at 100, process in concurrent batches of 6
  // (3 API calls per moment × 6 concurrent = 18 parallel requests max)
  const capped = moments.slice(0, 100);
  const CONCURRENCY = 6;
  const results: MomentOfferResult[] = [];

  for (let i = 0; i < capped.length; i += CONCURRENCY) {
    const batch = capped.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processMoment));
    results.push(...batchResults);
    if (i + CONCURRENCY < capped.length) {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  const offerMap: Record<string, MomentOfferResult> = {};
  for (const r of results) offerMap[r.momentId] = r;

  const withOffers = results.filter(r => r.bestOffer !== null);
  const flowtyHits = results.filter(r => r.flowtyOffer !== null);
  console.log(`[moment-offers] processed ${results.length} moments, ${withOffers.length} with offers, ${flowtyHits.length} Flowty offers`);

  return NextResponse.json({ offers: offerMap });
}