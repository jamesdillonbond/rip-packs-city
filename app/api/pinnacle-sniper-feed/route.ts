/**
 * app/api/pinnacle-sniper-feed/route.ts
 *
 * Sniper feed for Disney Pinnacle pins.
 * Data source: Flowty only (Pinnacle GQL is Cloudflare-blocked server-side).
 * FMV: Supabase pinnacle_fmv_snapshots (starts empty — confidence "NO_DATA").
 * Price: orders[0].salePrice is already USD. Do NOT divide by 100_000_000.
 * Total market: ~5,093 listed. Fetch 4 pages of 24 = 96 per call.
 */

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  type PinnacleSniperDeal,
  parseFranchise,
  parseVariant,
  parseTrait,
  parseCharacters,
  parseRoyaltyCode,
  buildEditionKey,
  isPinLocked,
  parseSerial,
  pinnacleSerialMultiplier,
} from "@/lib/pinnacle/pinnacleTypes";

export const dynamic = "force-dynamic";
export const maxDuration = 25;

const FLOWTY_ENDPOINT =
  "https://api2.flowty.io/collection/0xedf9df96c92f4595/Pinnacle";

const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

function flowtyBody(from: number) {
  return {
    address: null,
    addresses: [],
    collectionFilters: [
      { collection: "0xedf9df96c92f4595.Pinnacle", traits: [] },
    ],
    from,
    includeAllListings: true,
    limit: 24,
    onlyUnlisted: false,
    orderFilters: [
      { conditions: [], kind: "storefront", paymentTokens: [] },
    ],
    sort: {
      direction: "asc",
      listingKind: "storefront",
      path: "salePrice",
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchFlowtyPage(from: number): Promise<any[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify(flowtyBody(from)),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error(
        `[pinnacle-sniper] Flowty from=${from} HTTP ${res.status}`
      );
      return [];
    }
    const json = await res.json();
    const items = json.nfts ?? json.data ?? [];
    console.log(
      `[pinnacle-sniper] Flowty from=${from} count=${Array.isArray(items) ? items.length : 0}`
    );
    return Array.isArray(items) ? items : [];
  } catch (err) {
    console.error(
      `[pinnacle-sniper] Flowty from=${from} error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllListings(): Promise<any[]> {
  const pages = await Promise.all([0, 24, 48, 72].map(fetchFlowtyPage));
  const all = pages.flat();
  // Dedup by NFT id
  const seen = new Set<string>();
  return all.filter((nft) => {
    if (seen.has(nft.id)) return false;
    seen.add(nft.id);
    return true;
  });
}

interface FmvRow {
  edition_id: string;
  fmv_usd: number;
  confidence: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchFmv(supabase: any): Promise<Map<string, FmvRow>> {
  const { data, error } = await supabase
    .from("pinnacle_fmv_snapshots")
    .select("edition_id, fmv_usd, confidence")
    .order("computed_at", { ascending: false });
  if (error || !data) return new Map();
  const map = new Map<string, FmvRow>();
  for (const row of data as FmvRow[]) {
    if (!map.has(row.edition_id)) map.set(row.edition_id, row);
  }
  return map;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapNftToDeal(nft: any): PinnacleSniperDeal | null {
  try {
    const orders = nft.orders;
    if (!Array.isArray(orders) || orders.length === 0) return null;
    const order = orders[0];
    if (!order || order.state !== "LISTED") return null;

    const askPrice = parseFloat(String(order.salePrice));
    if (!askPrice || askPrice <= 0 || isNaN(askPrice)) return null;

    const traits: Array<{ name: string; value: string }> =
      nft.nftView?.traits?.traits ?? [];

    const variant = parseVariant(parseTrait(traits, "Variant"));
    const franchise = parseFranchise(parseTrait(traits, "Studios"));
    const characterRaw = parseTrait(traits, "Characters");
    const characterName =
      parseCharacters(characterRaw) ||
      nft.card?.title?.split("[")[0]?.trim() ||
      "Unknown";
    const setName = parseTrait(traits, "SetName").trim();
    const seriesYear =
      parseInt(parseTrait(traits, "SeriesName"), 10) || 0;
    const royaltyCode = parseRoyaltyCode(parseTrait(traits, "RoyaltyCodes"));
    const printing = parseTrait(traits, "Printing") || "1";
    const isChaser = parseTrait(traits, "IsChaser") === "true";
    const editionType = parseTrait(traits, "EditionType") || "Open Edition";

    const editionId = buildEditionKey(royaltyCode, variant, printing);
    const serial = parseSerial(traits);
    const mintCount = nft.nftView?.editions?.infoList?.[0]?.max ?? 0;
    const isLocked = isPinLocked(traits);

    const listingResourceID = order.listingResourceID ?? null;
    const storefrontAddress = order.storefrontAddress ?? null;

    return {
      flowId: String(nft.id),
      nftId: String(order.nftID ?? nft.id),
      editionId,
      characterName,
      franchise,
      setName,
      seriesYear,
      variant,
      editionType,
      isChaser,
      serial,
      mintCount,
      askPrice,
      baseFmv: 0,
      adjustedFmv: 0,
      discount: 0,
      confidence: "NO_DATA",
      serialMult: 1,
      isSpecialSerial: false,
      serialSignal: null,
      thumbnailUrl: null,
      isLocked,
      updatedAt: order.blockTimestamp
        ? new Date(Number(order.blockTimestamp)).toISOString()
        : null,
      buyUrl: "https://disneypinnacle.com/marketplace",
      listingResourceID,
      listingOrderID: listingResourceID,
      storefrontAddress,
      source: "flowty",
      offerAmount: null,
      offerFmvPct: null,
    };
  } catch (err) {
    console.error(
      `[pinnacle-sniper] mapNftToDeal error nft.id=${nft?.id}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

export async function GET(req: Request) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const url = new URL(req.url);
  const variantFilter = url.searchParams.get("variant") ?? "all";
  const franchiseFilter = url.searchParams.get("franchise") ?? "all";
  const maxPrice = parseFloat(url.searchParams.get("maxPrice") ?? "0");
  const sortBy = url.searchParams.get("sortBy") ?? "price_asc";
  const chaserOnly = url.searchParams.get("chaserOnly") === "true";

  const [allNfts, fmvMap] = await Promise.all([
    fetchAllListings(),
    fetchFmv(supabase),
  ]);

  console.log(`[pinnacle-sniper] Total from Flowty: ${allNfts.length}`);

  const deals: PinnacleSniperDeal[] = [];

  for (const nft of allNfts) {
    const deal = mapNftToDeal(nft);
    if (!deal) continue;
    if (maxPrice > 0 && deal.askPrice > maxPrice) continue;
    if (variantFilter !== "all" && deal.variant !== variantFilter) continue;
    if (franchiseFilter !== "all" && deal.franchise !== franchiseFilter)
      continue;
    if (chaserOnly && !deal.isChaser) continue;

    // Enrich with FMV if available
    const fmvRow = fmvMap.get(deal.editionId);
    if (fmvRow && fmvRow.fmv_usd > 0) {
      deal.baseFmv = fmvRow.fmv_usd;
      deal.confidence = fmvRow.confidence as PinnacleSniperDeal["confidence"];
      const { mult, signal, isSpecial } = pinnacleSerialMultiplier(
        deal.serial,
        deal.mintCount
      );
      deal.serialMult = mult;
      deal.serialSignal = signal;
      deal.isSpecialSerial = isSpecial;
      deal.adjustedFmv = deal.baseFmv * mult;
      deal.discount =
        deal.adjustedFmv > 0
          ? Math.round(
              ((deal.adjustedFmv - deal.askPrice) / deal.adjustedFmv) * 1000
            ) / 10
          : 0;
    }

    deals.push(deal);
  }

  // Sort
  if (sortBy === "price_desc") deals.sort((a, b) => b.askPrice - a.askPrice);
  else if (sortBy === "discount") deals.sort((a, b) => b.discount - a.discount);
  else deals.sort((a, b) => a.askPrice - b.askPrice); // price_asc default

  return NextResponse.json(
    {
      count: deals.length,
      flowtyTotal: allNfts.length,
      fmvCoverage: fmvMap.size,
      lastRefreshed: new Date().toISOString(),
      deals: deals.slice(0, 200),
    },
    {
      headers: {
        "Cache-Control":
          "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
      },
    }
  );
}
