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
  0: "Series 1", 2: "Series 2", 3: "Summer 2021", 4: "Series 3",
  5: "Series 4", 6: "Series 2023-24", 7: "Series 2024-25", 8: "Series 2025-26",
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
  if (!Array.isArray(traits)) return "";
  const t = traits.find(function(tr: any) { return tr && (tr.name === name || tr.trait_type === name); });
  return t && t.value ? String(t.value) : "";
}

async function fetchFlowtyPage(from: number): Promise<any[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 8000);
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST", headers: FLOWTY_HEADERS,
      body: JSON.stringify(flowtyBody(from)), signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.log("[listing-cache] Flowty page " + from + " HTTP " + res.status);
      return [];
    }
    const json = await res.json();
    const items = json.data || json.nfts || [];
    return Array.isArray(items) ? items : [];
  } catch (e: any) {
    console.log("[listing-cache] Flowty page " + from + " error: " + (e.message || "unknown"));
    return [];
  }
}

function mapFlowtyListing(nft: any): any | null {
  try {
    if (!nft) return null;
    const orders = nft.orders;
    if (!Array.isArray(orders) || orders.length === 0) return null;
    const order = orders[0];
    if (!order || order.state !== "LISTED") return null;

    const price = parseFloat(order.salePrice);
    if (!price || price <= 0 || isNaN(price)) return null;

    const blended = nft.valuations && nft.valuations.blended;
    const fmvRaw = blended && blended.usdValue ? blended.usdValue : null;
    const fmvNum = fmvRaw ? parseFloat(String(fmvRaw)) : null;
    const discount = fmvNum && fmvNum > 0 && isFinite(fmvNum) ? ((fmvNum - price) / fmvNum) * 100 : null;

    const traits = (nft.nftView && Array.isArray(nft.nftView.traits)) ? nft.nftView.traits : [];
    const seriesStr = getTrait(traits, "SeriesNumber");
    const seriesNum = seriesStr ? parseInt(seriesStr, 10) : null;
    const tier = getTrait(traits, "Tier") || "COMMON";
    const playerName = (nft.card && nft.card.title ? String(nft.card.title) : "").trim();
    const flowId = nft.id ? String(nft.id) : "";
    const listingResourceId = order.listingResourceID ? String(order.listingResourceID) : "";

    if (!playerName || !flowId) return null;

    const serial = parseInt(String((nft.card && nft.card.num) || "0"), 10) || 0;
    const circ = parseInt(String((nft.card && nft.card.max) || "0"), 10) || 0;
    const imageUrl = (nft.card && Array.isArray(nft.card.images) && nft.card.images[0]) ? nft.card.images[0].url : null;

    return {
      id: "flowty-" + flowId + "-" + listingResourceId,
      flow_id: flowId,
      moment_id: (nft.nftView && nft.nftView.uuid) ? String(nft.nftView.uuid) : null,
      player_name: playerName,
      team_name: getTrait(traits, "TeamAtMoment"),
      set_name: getTrait(traits, "SetName"),
      series_name: (seriesNum !== null && !isNaN(seriesNum)) ? (SERIES_NAMES[seriesNum] || "Series " + seriesNum) : "",
      tier: tier.toUpperCase(),
      serial_number: serial,
      circulation_count: circ,
      ask_price: price,
      fmv: fmvNum,
      adjusted_fmv: fmvNum,
      discount: (discount !== null && isFinite(discount)) ? Math.round(discount * 100) / 100 : null,
      confidence: fmvNum ? "HIGH" : null,
      source: "flowty",
      buy_url: "https://www.flowty.io/asset/A.0b2a3299cc857e29.TopShot.NFT/" + flowId,
      thumbnail_url: imageUrl,
      badge_slugs: [],
      listing_resource_id: listingResourceId,
      storefront_address: order.storefrontAddress ? String(order.storefrontAddress) : "",
      is_locked: getTrait(traits, "Locked") === "true",
      raw_data: null,
      listed_at: order.blockTimestamp ? new Date(Number(order.blockTimestamp)).toISOString() : null,
      cached_at: new Date().toISOString(),
    };
  } catch (e: any) {
    console.log("[listing-cache] Map error: " + (e.message || "unknown"));
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization");
    if (auth !== ("Bearer " + process.env.INGEST_SECRET_TOKEN)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const startTime = Date.now();
    const pageOffsets = [0, 24, 48, 72, 96, 120];
    const pageResults = await Promise.all(pageOffsets.map(function(off) { return fetchFlowtyPage(off); }));
    const allNfts = pageResults.flat();
    console.log("[listing-cache] Fetched " + allNfts.length + " raw NFTs from Flowty");

    if (allNfts.length === 0) {
      return NextResponse.json({
        ok: true, message: "Flowty returned 0 - preserving existing cache",
        cached: 0, elapsed: Date.now() - startTime,
      });
    }

    const listings: any[] = [];
    for (let i = 0; i < allNfts.length; i++) {
      const mapped = mapFlowtyListing(allNfts[i]);
      if (mapped) listings.push(mapped);
    }
    console.log("[listing-cache] Mapped " + listings.length + " valid listings");

    if (listings.length === 0) {
      return NextResponse.json({
        ok: true, message: "All listings filtered out during mapping",
        fetched: allNfts.length, cached: 0, elapsed: Date.now() - startTime,
      });
    }

    const delResult = await supabase.from("cached_listings").delete().eq("source", "flowty");
    if (delResult.error) {
      console.log("[listing-cache] Delete error: " + delResult.error.message);
    }

    let inserted = 0;
    let insertErrors = 0;
    for (let i = 0; i < listings.length; i += 25) {
      const chunk = listings.slice(i, i + 25);
      const result = await supabase.from("cached_listings").insert(chunk);
      if (result.error) {
        console.log("[listing-cache] Insert chunk " + i + " error: " + result.error.message);
        insertErrors++;
        // Try inserting one by one to find the bad row
        for (let j = 0; j < chunk.length; j++) {
          const single = await supabase.from("cached_listings").insert([chunk[j]]);
          if (single.error) {
            console.log("[listing-cache] Bad row " + (i + j) + " id=" + chunk[j].id + ": " + single.error.message);
          } else {
            inserted++;
          }
        }
      } else {
        inserted += chunk.length;
      }
    }

    console.log("[listing-cache] Done: " + inserted + " inserted, " + insertErrors + " chunk errors");

    return NextResponse.json({
      ok: true, fetched: allNfts.length, mapped: listings.length,
      cached: inserted, errors: insertErrors, elapsed: Date.now() - startTime,
    });
  } catch (e: any) {
    console.error("[listing-cache] FATAL: " + (e.message || "unknown"), e.stack || "");
    return NextResponse.json({ ok: false, error: e.message || "Unknown error" }, { status: 500 });
  }
}
