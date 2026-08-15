// app/api/edition-floor/route.ts
//
// Returns real-time cross-market lowest ask for one or more editions.
// Queries Top Shot active listings + Flowty active listings in parallel.
// Optionally writes results back to fmv_snapshots (top_shot_ask, flowty_ask, cross_market_ask).
//
// GET  /api/edition-floor?editionKey=setUUID:playUUID[&persist=1]
// POST /api/edition-floor  { editionKeys: string[], persist?: boolean }
//
// The READ is anonymous (proxy.ts opens this path). `persist` additionally
// requires `Authorization: Bearer $CRON_SECRET` or `$INGEST_SECRET_TOKEN` —
// it performs a service-role DELETE on fmv_snapshots. An unauthorized caller
// is not rejected; the flag is simply ignored, so the existing read contract
// is unchanged for every current caller (deep-audit R2).

import { NextRequest, NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { selectCrossMarketFloor } from "@/lib/cross-market-floor";

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

  const { crossMarketFloor, crossMarketSource } = selectCrossMarketFloor(ts.floor, flowty.floor);

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
      .select("id, collection_id, external_id, tier")
      .in("external_id", editionKeys);

    if (!editionRows?.length) return;

    // ULTIMATE rows in fmv_snapshots are owned exclusively by recalc_ultimate_fmv.
    // Skip them here so floor-only persists never land on an Ultimate row.
    const extToRow = new Map<string, { id: string; collection_id: string }>();
    for (const row of editionRows as { id: string; collection_id: string; external_id: string; tier: string | null }[]) {
      if (String(row.tier ?? "").toUpperCase() === "ULTIMATE") continue;
      extToRow.set(row.external_id, { id: row.id, collection_id: row.collection_id });
    }

    // Use the post-ULTIMATE-skip set so we never read/delete ultimate-v1 rows.
    const editionIds = [...extToRow.values()].map((r) => r.id);

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

// ── `persist` is OPERATOR-ONLY (deep-audit R2, P0-latent) ───────────────────
// `proxy.ts` opens this route to anonymous GET/POST as a "stateless read-
// compute". That was true of the read and false of `persist`: both handlers
// took the flag straight from the caller and ran `persistFloorToSnapshot`,
// which builds a SERVICE_ROLE client and DELETEs today's `fmv_snapshots` rows
// for up to 50 editions before re-inserting. So an unauthenticated request
// could destroy live pricing data — and if the re-insert then failed (the
// re-insert is built from the prior row, `confidence` is NOT NULL, and the
// read it depends on is 1000-row capped) the delete had already committed,
// inside a catch that logs "persist failed (non-fatal)".
//
// ⚠ `check_anon_write_surface()` is blind to this BY CONSTRUCTION: it tests the
// anon DB ROLE, and this route holds the service-role key. The guard-scope
// class again — the probe's own derivation fixed what it could ever see.
//
// Gated rather than deleted: writing floor data into snapshots is legitimate
// work for an authenticated caller, and removing the capability is a product
// call. The READ path is untouched and stays anonymous.
function persistAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const ingest = process.env.INGEST_SECRET_TOKEN;
  return (
    (!!cronSecret && auth === `Bearer ${cronSecret}`) ||
    (!!ingest && auth === `Bearer ${ingest}`)
  );
}

export async function GET(req: NextRequest) {
  const editionKey = req.nextUrl.searchParams.get("editionKey");
  const persist = req.nextUrl.searchParams.get("persist") === "1" && persistAuthorized(req);

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
    persist = body.persist === true && persistAuthorized(req);
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