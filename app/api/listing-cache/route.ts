import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

const SERIES_NAMES: Record<number, string> = {
  0: "Beta", 1: "Series 1", 2: "Series 2", 3: "Series 3", 4: "Series 4",
  5: "Series 5", 6: "Series 6", 7: "Series 7", 8: "Series 8",
};

function flowtyBody(from: number) {
  return {
    address: null, addresses: [],
    collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
    from, includeAllListings: true, limit: 24, onlyUnlisted: false,
    orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
    sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
  };
}

function getTrait(traits: any[], name: string): string {
  const t = traits?.find((tr: any) => tr.name === name || tr.trait_type === name);
  return t?.value ?? "";
}

async function fetchFlowtyPage(from: number): Promise<any[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST", headers: FLOWTY_HEADERS,
      body: JSON.stringify(flowtyBody(from)), signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const json = await res.json();
    return json?.data ?? json?.nfts ?? [];
  } catch { return []; }
}

function mapFlowtyListing(nft: any): any | null {
  const order = nft?.orders?.[0];
  if (!order || order.state !== "LISTED") return null;
  const price = parseFloat(order.salePrice);
  if (!price || price <= 0) return null;

  const fmv = nft?.valuations?.blended?.usdValue ?? null;
  const fmvNum = fmv ? parseFloat(fmv) : null;
  const discount = fmvNum && fmvNum > 0 ? ((fmvNum - price) / fmvNum) * 100 : null;

  const traits = nft?.nftView?.traits ?? [];
  const seriesStr = getTrait(traits, "SeriesNumber");
  const seriesNum = seriesStr ? parseInt(seriesStr) : null;
  const tier = getTrait(traits, "Tier") || "COMMON";
  const playerName = (nft?.card?.title ?? "").trim();
  const flowId = String(nft?.id ?? "");
  const listingResourceId = String(order?.listingResourceID ?? "");

  if (!playerName || !flowId) return null;

  return {
    id: `flowty-${flowId}-${listingResourceId}`,
    flow_id: flowId,
    moment_id: nft?.nftView?.uuid ?? null,
    player_name: playerName,
    team_name: getTrait(traits, "TeamAtMoment") || "",
    set_name: getTrait(traits, "SetName") || "",
    series_name: seriesNum != null ? (SERIES_NAMES[seriesNum] ?? `Series ${seriesNum}`) : "",
    tier: tier.toUpperCase(),
    serial_number: parseInt(nft?.card?.num ?? "0") || 0,
    circulation_count: parseInt(nft?.card?.max ?? "0") || 0,
    ask_price: price,
    fmv: fmvNum,
    adjusted_fmv: fmvNum,
    discount: discount ? Math.round(discount * 100) / 100 : null,
    confidence: fmvNum ? "HIGH" : null,
    source: "flowty",
    buy_url: `https://www.flowty.io/listing/${listingResourceId}`,
    thumbnail_url: nft?.card?.images?.[0]?.url ?? null,
    badge_slugs: [],
    listing_resource_id: listingResourceId,
    storefront_address: order?.storefrontAddress ?? "",
    is_locked: getTrait(traits, "Locked") === "true",
    raw_data: { subeditionId: getTrait(traits, "SubeditionID"), paymentToken: order?.paymentTokenName },
    listed_at: order?.blockTimestamp ? new Date(Number(order.blockTimestamp)).toISOString() : null,
    cached_at: new Date().toISOString(),
  };
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const pageOffsets = [0, 24, 48, 72, 96, 120];
  const pageResults = await Promise.all(pageOffsets.map((off) => fetchFlowtyPage(off)));
  const allNfts = pageResults.flat();
  console.log(`[listing-cache] Fetched ${allNfts.length} raw NFTs from Flowty`);

  if (allNfts.length === 0) {
    return NextResponse.json({
      ok: true, message: "Flowty returned 0 — preserving existing cache",
      cached: 0, elapsed: Date.now() - startTime,
    });
  }

  const listings = allNfts.map(mapFlowtyListing).filter(Boolean);
  console.log(`[listing-cache] Mapped ${listings.length} valid listings`);

  const { error: deleteError } = await supabase.from("cached_listings").delete().eq("source", "flowty");
  if (deleteError) console.error("[listing-cache] Delete error:", deleteError.message);

  let inserted = 0;
  for (let i = 0; i < listings.length; i += 50) {
    const chunk = listings.slice(i, i + 50);
    const { error } = await supabase.from("cached_listings").insert(chunk);
    if (error) console.error(`[listing-cache] Insert chunk ${i}:`, error.message);
    else inserted += chunk.length;
  }

  return NextResponse.json({
    ok: true, fetched: allNfts.length, mapped: listings.length, cached: inserted,
    elapsed: Date.now() - startTime,
  });
}
