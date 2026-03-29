// app/api/moment-offers/route.ts
// Fetches serial-level and edition-level offers for a batch of moments.
// Serial offers: GetTopOffers with byMomentID — offers on a specific serial
// Edition offers: GetTopOffers with byEdition — highest offer on any moment in the edition
// Both use the same confirmed-working query from browser network capture.

import { NextResponse } from "next/server";

const TOPSHOT_GQL = "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://nbatopshot.com",
  Referer: "https://nbatopshot.com/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
};

// Confirmed query from browser network capture
// variables: { byMomentID: string, byOfferTypes: ["Serial"], limit: 5 }
// variables: { byEdition: { setID, playID }, byOfferTypes: ["Edition"], limit: 1 }
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

// Get the highest active offer price from a list of offers
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
        variables: {
          byMomentID: momentId,
          byOfferTypes: ["Serial"],
          limit: 5,
        },
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
        variables: {
          byEdition: { setID, playID },
          byOfferTypes: ["Edition"],
          limit: 1,
        },
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

interface MomentOfferInput {
  momentId: string;
  setID: string;
  playID: string;
}

interface MomentOfferResult {
  momentId: string;
  serialOffer: number | null;   // offer on this specific serial
  editionOffer: number | null;  // highest offer on any moment in the edition
  bestOffer: number | null;     // max of the above
}

// Process in batches to avoid hammering the API
async function processBatch(items: MomentOfferInput[]): Promise<MomentOfferResult[]> {
  return Promise.all(
    items.map(async ({ momentId, setID, playID }) => {
      // Fire serial and edition offers in parallel for each moment
      const [serialOffer, editionOffer] = await Promise.all([
        fetchSerialOffer(momentId),
        fetchEditionOffer(setID, playID),
      ]);
      const bestOffer =
        serialOffer !== null && editionOffer !== null
          ? Math.max(serialOffer, editionOffer)
          : serialOffer ?? editionOffer ?? null;
      return { momentId, serialOffer, editionOffer, bestOffer };
    })
  );
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

  // Cap at 200, process in concurrent batches of 8
  const capped = moments.slice(0, 200);
  const CONCURRENCY = 8;
  const results: MomentOfferResult[] = [];

  for (let i = 0; i < capped.length; i += CONCURRENCY) {
    const batch = capped.slice(i, i + CONCURRENCY);
    const batchResults = await processBatch(batch);
    results.push(...batchResults);
    // Small delay between batches to be respectful of rate limits
    if (i + CONCURRENCY < capped.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Return as a map keyed by momentId for O(1) client-side lookup
  const offerMap: Record<string, MomentOfferResult> = {};
  for (const r of results) {
    offerMap[r.momentId] = r;
  }

  console.log(`[moment-offers] processed ${results.length} moments, ${results.filter(r => r.bestOffer !== null).length} with active offers`);

  return NextResponse.json({ offers: offerMap });
}