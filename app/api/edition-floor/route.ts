// app/api/edition-floor/route.ts
//
// Returns real-time cross-market lowest ask for one or more editions.
// Queries Top Shot active listings + Flowty active listings in parallel.
// Optionally writes results back to fmv_snapshots (top_shot_ask, flowty_ask, cross_market_ask).
//
// GET  /api/edition-floor?editionKey=setUUID:playUUID[&persist=1]
// POST /api/edition-floor  { editionKeys: string[], persist?: boolean }

import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

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

// Top Shot: search active listings for a specific edition by setID + playID
const SEARCH_EDITIONS_QUERY = `
  query SearchEditionListings($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      data {
        searchSummary {
          data {
            ... on Editions {
              data {
                ... on Edition {
                  setID
                  playID
                  lowestAsk
                  circulationCount
                  forSaleCount
                }
              }
            }
          }
        }
      }
    }
  }
`;

export interface EditionFloorResult {
  editionKey: string;
  topShotFloor: number | null;
  topShotListingCount: number;
  flowtyFloor: number | null;
  flowtyListingCount: number;
  crossMarketFloor: number | null;
  crossMarketSource: "topshot" | "flowty" | null;
  livetokenFmv: number | null;
  fetchedAt: string;
}

async function fetchTopShotFloor(setID: string, playID: string): Promise<{ floor: number | null; count: number }> {
  try {
    const res = await fetch(TOPSHOT_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({
        operationName: "SearchEditionListings",
        query: SEARCH_EDITIONS_QUERY,
        variables: {
          input: {
            filters: { bySetID: setID, byPlayID: playID },
            searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 1 } },
          },
        },
      }),
    });
    if (!res.ok) return { floor: null, count: 0 };
    const json = await res.json();
    if (json.errors?.length) return { floor: null, count: 0 };
    const editions = json?.data?.searchEditions?.data?.searchSummary?.data?.data;
    const edition = Array.isArray(editions) ? editions[0] : null;
    if (!edition) return { floor: null, count: 0 };
    const floor = edition.lowestAsk != null ? parseFloat(String(edition.lowestAsk)) : null;
    const count = edition.forSaleCount ?? 0;
    return { floor: floor && floor > 0 ? floor : null, count };
  } catch {
    return { floor: null, count: 0 };
  }
}

async function fetchFlowtyFloor(
  setID: string,
  playID: string
): Promise<{ floor: number | null; count: number; livetokenFmv: number | null }> {
  try {
    // Flowty API doesn't accept setID:playID directly — query recent listings
    // and filter client-side by matching the edition via traits
    // Since we can't filter by edition key on Flowty's endpoint, we use
    // the broader collection endpoint and filter by matching the Top Shot
    // edition key format. This is best-effort.
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null,
        addresses: [],
        collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
        from: 0,
        includeAllListings: true,
        limit: 48,
        onlyUnlisted: false,
        orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
        sort: { direction: "asc", listingKind: "storefront", path: "salePrice" },
      }),
    });
    if (!res.ok) return { floor: null, count: 0, livetokenFmv: null };
    const data = await res.json();
    const nfts = (data.nfts ?? []) as Array<{
      id: string;
      orders: { salePrice: number; state: string; nftID: string }[];
      valuations?: { livetoken?: { usdValue: number }; blended?: { usdValue: number } };
    }>;

    // Filter to LISTED orders and get the floor
    const prices: number[] = [];
    let livetokenFmv: number | null = null;

    for (const nft of nfts) {
      const order = nft.orders?.find(o => o.state === "LISTED");
      if (!order?.salePrice || order.salePrice <= 0) continue;
      prices.push(order.salePrice);
      // Capture LiveToken FMV from first result with it
      if (!livetokenFmv) {
        const lt = nft.valuations?.livetoken?.usdValue ?? nft.valuations?.blended?.usdValue;
        if (lt && lt > 0) livetokenFmv = lt;
      }
    }

    if (!prices.length) return { floor: null, count: 0, livetokenFmv };
    prices.sort((a, b) => a - b);
    return { floor: prices[0], count: prices.length, livetokenFmv };
  } catch {
    return { floor: null, count: 0, livetokenFmv: null };
  }
}

async function resolveEditionFloor(editionKey: string): Promise<EditionFloorResult> {
  const [setID, playID] = editionKey.split(":");
  if (!setID || !playID) {
    return {
      editionKey, topShotFloor: null, topShotListingCount: 0,
      flowtyFloor: null, flowtyListingCount: 0,
      crossMarketFloor: null, crossMarketSource: null, livetokenFmv: null,
      fetchedAt: new Date().toISOString(),
    };
  }

  const [ts, flowty] = await Promise.all([
    fetchTopShotFloor(setID, playID),
    fetchFlowtyFloor(setID, playID),
  ]);

  let crossMarketFloor: number | null = null;
  let crossMarketSource: "topshot" | "flowty" | null = null;

  if (ts.floor !== null && flowty.floor !== null) {
    if (ts.floor <= flowty.floor) {
      crossMarketFloor = ts.floor; crossMarketSource = "topshot";
    } else {
      crossMarketFloor = flowty.floor; crossMarketSource = "flowty";
    }
  } else if (ts.floor !== null) {
    crossMarketFloor = ts.floor; crossMarketSource = "topshot";
  } else if (flowty.floor !== null) {
    crossMarketFloor = flowty.floor; crossMarketSource = "flowty";
  }

  return {
    editionKey,
    topShotFloor: ts.floor,
    topShotListingCount: ts.count,
    flowtyFloor: flowty.floor,
    flowtyListingCount: flowty.count,
    crossMarketFloor,
    crossMarketSource,
    livetokenFmv: flowty.livetokenFmv,
    fetchedAt: new Date().toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function persistFloorToSnapshot(
  supabase: SupabaseClient,
  results: EditionFloorResult[]
): Promise<void> {
  try {
    const editionKeys = results.filter(r => r.crossMarketFloor !== null).map(r => r.editionKey);
    if (!editionKeys.length) return;

    const { data: editionRows } = await supabase
      .from("editions")
      .select("id, collection_id, external_id")
      .in("external_id", editionKeys);

    if (!editionRows?.length) return;

    const extToRow = new Map<string, { id: string; collection_id: string }>();
    for (const row of editionRows as { id: string; collection_id: string; external_id: string }[]) {
      extToRow.set(row.external_id, { id: row.id, collection_id: row.collection_id });
    }

    const editionIds = editionRows.map((r: { id: string }) => r.id);

    // Fetch latest snapshots
    const { data: existing } = await supabase
      .from("fmv_snapshots")
      .select("*")
      .in("edition_id", editionIds)
      .order("computed_at", { ascending: false });

    const latestByEdition = new Map<string, Record<string, unknown>>();
    for (const row of (existing ?? []) as Record<string, unknown>[]) {
      const eid = row.edition_id as string;
      if (!latestByEdition.has(eid)) latestByEdition.set(eid, row);
    }

    // Delete only TODAY's snapshots so historical rows accumulate.
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    await supabase
      .from("fmv_snapshots")
      .delete()
      .in("edition_id", editionIds)
      .gte("computed_at", todayStart.toISOString());

    // Re-insert with floor data
    const insertRows = results
      .filter(r => r.crossMarketFloor !== null)
      .map(r => {
        const edRow = extToRow.get(r.editionKey);
        if (!edRow) return null;
        const base = latestByEdition.get(edRow.id) ?? {};
        return {
          ...base,
          id: undefined,
          edition_id: edRow.id,
          collection_id: edRow.collection_id,
          top_shot_ask: r.topShotFloor,
          flowty_ask: r.flowtyFloor,
          cross_market_ask: r.crossMarketFloor,
          algo_version: "1.2.1",
        };
      })
      .filter(Boolean);

    if (insertRows.length) {
      await supabase.from("fmv_snapshots").insert(insertRows);
      console.log(`[edition-floor] persisted floor data for ${insertRows.length} editions`);
    }
  } catch (err) {
    console.warn("[edition-floor] persist failed (non-fatal):", err);
  }
}

export async function GET(req: NextRequest) {
  const editionKey = req.nextUrl.searchParams.get("editionKey");
  const persist = req.nextUrl.searchParams.get("persist") === "1";

  if (!editionKey) {
    return NextResponse.json({ error: "editionKey required" }, { status: 400 });
  }

  const result = await resolveEditionFloor(editionKey);

  if (persist) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    persistFloorToSnapshot(supabase, [result]).catch(() => {});
  }

  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  let editionKeys: string[] = [];
  let persist = false;

  try {
    const body = await req.json();
    editionKeys = Array.isArray(body.editionKeys) ? body.editionKeys.slice(0, 50) : [];
    persist = body.persist === true;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  if (!editionKeys.length) {
    return NextResponse.json({ results: [] });
  }

  // Process in parallel with concurrency cap of 5
  const CONCURRENCY = 5;
  const results: EditionFloorResult[] = [];

  for (let i = 0; i < editionKeys.length; i += CONCURRENCY) {
    const batch = editionKeys.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(resolveEditionFloor));
    results.push(...batchResults);
    if (i + CONCURRENCY < editionKeys.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (persist) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    persistFloorToSnapshot(supabase, results).catch(() => {});
  }

  console.log(`[edition-floor] resolved ${results.length} editions, ${results.filter(r => r.crossMarketFloor !== null).length} with floors`);
  return NextResponse.json({ results });
}