import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fireNextPipelineStep } from "@/lib/pipeline-chain";

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

const PAGE_SIZE = 24;

// ── Collection configs ──────────────────────────────────────────────────────
// Each collection defines its Flowty endpoint, filter, series labels, buy URL,
// and the number of pages to fetch per run.

type CollectionConfig = {
  slug: string;
  collectionId: string;
  flowtyEndpoint: string;
  flowtyCollectionFilter: string;
  seriesNames: Record<number, string>;
  buyUrlBase: string;
  pagesToFetch: number;
  // If set, chain to this collection slug after this one completes
  chainNext: string | null;
  // If true, call fmv_from_cached_listings RPC after inserting listings
  askOnlyFmv: boolean;
};

const COLLECTIONS: Record<string, CollectionConfig> = {
  "nba-top-shot": {
    slug: "nba-top-shot",
    collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    flowtyEndpoint: "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot",
    flowtyCollectionFilter: "0x0b2a3299cc857e29.TopShot",
    seriesNames: {
      0: "Series 1", 2: "Series 2", 3: "Summer 2021", 4: "Series 3",
      5: "Series 4", 6: "Series 2023-24", 7: "Series 2024-25", 8: "Series 2025-26",
    },
    buyUrlBase: "https://www.flowty.io/asset/0x0b2a3299cc857e29/TopShot/NFT/",
    pagesToFetch: 22,
    chainNext: "nfl-all-day",
    askOnlyFmv: false,
  },
  "nfl-all-day": {
    slug: "nfl-all-day",
    collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
    flowtyEndpoint: "https://api2.flowty.io/collection/0xe4cf4bdc1751c65d/AllDay",
    flowtyCollectionFilter: "0xe4cf4bdc1751c65d.AllDay",
    seriesNames: {
      0: "Series 1", 1: "Series 2", 2: "Series 3", 3: "Series 4", 4: "Series 5",
    },
    buyUrlBase: "https://www.flowty.io/asset/0xe4cf4bdc1751c65d/AllDay/NFT/",
    pagesToFetch: 6,
    chainNext: null,
    askOnlyFmv: true,
  },
};

function getCollectionConfig(slug: string | null): CollectionConfig {
  if (slug && COLLECTIONS[slug]) return COLLECTIONS[slug];
  return COLLECTIONS["nba-top-shot"];
}

function flowtyBody(from: number, config: CollectionConfig) {
  return {
    address: null, addresses: [],
    collectionFilters: [{ collection: config.flowtyCollectionFilter, traits: [] }],
    from, includeAllListings: true, limit: PAGE_SIZE, onlyUnlisted: false,
    orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
    sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
  };
}

// Multi-variant trait lookup — tries each name in order (case-sensitive match
// on trait.name or trait.trait_type), returns first non-empty hit.
function getTraitMulti(traits: any[], ...names: string[]): string {
  if (!Array.isArray(traits)) return "";
  for (const name of names) {
    const t = traits.find(function(tr: any) {
      return tr && (tr.name === name || tr.trait_type === name);
    });
    if (t && t.value != null && String(t.value).trim() !== "") return String(t.value).trim();
  }
  return "";
}

async function fetchFlowtyPage(from: number, config: CollectionConfig): Promise<any[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(function() { controller.abort(); }, 8000);
    const res = await fetch(config.flowtyEndpoint, {
      method: "POST", headers: FLOWTY_HEADERS,
      body: JSON.stringify(flowtyBody(from, config)), signal: controller.signal,
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

function mapFlowtyListing(nft: any, config: CollectionConfig): any | null {
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

    // Extract traits with multi-variant names (covers Top Shot + All Day + future collections)
    const seriesStr = getTraitMulti(traits, "SeriesNumber", "seriesNumber", "Series Number", "series");
    const seriesNum = seriesStr ? parseInt(seriesStr, 10) : null;
    const tier = getTraitMulti(traits, "Tier", "Moment Tier", "tier", "momentTier") || "COMMON";
    const teamName = getTraitMulti(traits, "TeamAtMoment", "Team", "teamAtMoment", "team", "TeamName", "teamName");
    const setName = getTraitMulti(traits, "SetName", "Set Name", "setName", "set_name");
    const editionFlowID = getTraitMulti(traits, "Edition ID", "editionID", "editionFlowID", "EditionFlowID");

    // Player name: prefer card.title (works for both), fall back to trait variants
    const playerName = (
      (nft.card && nft.card.title ? String(nft.card.title) : "") ||
      getTraitMulti(traits, "Full Name", "Player Name", "playerFullName", "playerName", "name")
    ).trim();
    const flowId = nft.id ? String(nft.id) : "";
    const listingResourceId = order.listingResourceID ? String(order.listingResourceID) : "";

    if (!playerName || !flowId) return null;

    const serial = parseInt(String((nft.card && nft.card.num) || "0"), 10) || 0;
    const circ = parseInt(String((nft.card && nft.card.max) || "0"), 10) || 0;

    // Thumbnail: for All Day, build from edition ID; for others, use card images
    let imageUrl: string | null = null;
    if (config.slug === "nfl-all-day" && editionFlowID) {
      imageUrl = "https://media.nflallday.com/editions/" + editionFlowID + "/media/image?width=512&format=webp&quality=90";
    } else {
      imageUrl = (nft.card && Array.isArray(nft.card.images) && nft.card.images[0]) ? nft.card.images[0].url : null;
    }

    // moment_id: for All Day, use editionFlowID (maps to editions.external_id);
    // for Top Shot, use nftView.uuid
    const momentId = config.slug === "nfl-all-day"
      ? (editionFlowID || null)
      : ((nft.nftView && nft.nftView.uuid) ? String(nft.nftView.uuid) : null);

    return {
      id: "flowty-" + flowId + "-" + listingResourceId,
      flow_id: flowId,
      moment_id: momentId,
      player_name: playerName,
      team_name: teamName,
      set_name: setName,
      series_name: (seriesNum !== null && !isNaN(seriesNum)) ? (config.seriesNames[seriesNum] || "Series " + seriesNum) : "",
      tier: tier.toUpperCase(),
      serial_number: serial,
      circulation_count: circ,
      ask_price: price,
      fmv: fmvNum,
      adjusted_fmv: fmvNum,
      discount: (discount !== null && isFinite(discount)) ? Math.round(discount * 100) / 100 : null,
      confidence: fmvNum ? "HIGH" : null,
      source: "flowty",
      collection_id: config.collectionId,
      buy_url: config.buyUrlBase + flowId + "?listingResourceID=" + listingResourceId,
      thumbnail_url: imageUrl,
      badge_slugs: [],
      listing_resource_id: listingResourceId,
      storefront_address: order.storefrontAddress ? String(order.storefrontAddress) : "",
      is_locked: getTraitMulti(traits, "Locked", "locked") === "true",
      raw_data: null,
      listed_at: order.blockTimestamp ? new Date(Number(order.blockTimestamp)).toISOString() : null,
      cached_at: new Date().toISOString(),
    };
  } catch (e: any) {
    console.log("[listing-cache] Map error: " + (e.message || "unknown"));
    return null;
  }
}

// After cached_listings is refreshed, create LOW-confidence fmv_snapshots for
// editions that have active listings but NO existing FMV. Uses the minimum
// Flowty ask price as an ask-proxy value. Never overwrites sales-based FMV.
// Join path: cached_listings.flow_id → moments.nft_id → moments.edition_id.
async function backfillAskProxyFmv(listings: any[]): Promise<{ created: number; editionsConsidered: number }> {
  const flowIds = [...new Set(
    listings.map(function(l: any) { return l.flow_id; }).filter(Boolean)
  )] as string[];
  if (flowIds.length === 0) return { created: 0, editionsConsidered: 0 };

  // Resolve flow_id → edition_id via moments table (populated by sales-indexer + wallet-search)
  const nftToEdition = new Map<string, string>();
  for (let i = 0; i < flowIds.length; i += 200) {
    const chunk = flowIds.slice(i, i + 200);
    const { data: rows } = await supabase
      .from("moments")
      .select("nft_id, edition_id")
      .in("nft_id", chunk);
    for (const row of rows ?? []) {
      if (row.nft_id && row.edition_id) nftToEdition.set(String(row.nft_id), row.edition_id);
    }
  }
  if (nftToEdition.size === 0) return { created: 0, editionsConsidered: 0 };

  // Aggregate min ask per edition_id
  const minAskByEdition = new Map<string, number>();
  for (const l of listings) {
    const editionId = nftToEdition.get(String(l.flow_id));
    if (!editionId) continue;
    const price = Number(l.ask_price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const current = minAskByEdition.get(editionId);
    if (current === undefined || price < current) minAskByEdition.set(editionId, price);
  }
  if (minAskByEdition.size === 0) return { created: 0, editionsConsidered: 0 };

  const editionIds = [...minAskByEdition.keys()];

  // Find which of these editions already have an FMV snapshot (any confidence)
  const existingEditionIds = new Set<string>();
  for (let i = 0; i < editionIds.length; i += 200) {
    const chunk = editionIds.slice(i, i + 200);
    const { data: existing } = await supabase
      .from("fmv_snapshots")
      .select("edition_id")
      .in("edition_id", chunk);
    for (const row of existing ?? []) {
      if (row.edition_id) existingEditionIds.add(row.edition_id);
    }
  }

  // Only insert FMV rows for editions with no existing snapshot
  const now = new Date().toISOString();
  const newRows: any[] = [];
  for (const [editionId, minAsk] of minAskByEdition.entries()) {
    if (existingEditionIds.has(editionId)) continue;
    // Ask-proxy FMV: discount low ask by 10% to approximate realistic FMV.
    const fmvUsd = Math.round(minAsk * 0.9 * 100) / 100;
    newRows.push({
      edition_id: editionId,
      fmv_usd: fmvUsd,
      ask_proxy_fmv: minAsk,
      confidence: "LOW",
      algo_version: "v1.5.1_ask_proxy",
      computed_at: now,
      listing_count: 1,
    });
  }

  let created = 0;
  for (let i = 0; i < newRows.length; i += 100) {
    const chunk = newRows.slice(i, i + 100);
    const { error } = await supabase.from("fmv_snapshots").insert(chunk);
    if (error) {
      console.log("[listing-cache] ask-proxy insert error: " + error.message);
    } else {
      created += chunk.length;
    }
  }

  return { created, editionsConsidered: minAskByEdition.size };
}

// Call the fmv_from_cached_listings RPC to create ASK_ONLY fmv_snapshots
// for collections that don't have sales-based FMV (e.g. All Day).
async function runAskOnlyFmv(collectionId: string): Promise<number> {
  try {
    const { data, error } = await supabase.rpc("fmv_from_cached_listings", {
      p_collection_id: collectionId,
      p_algo_version: "v1.0_ask_only",
    });
    if (error) {
      console.log("[listing-cache] fmv_from_cached_listings error: " + error.message);
      return 0;
    }
    const count = typeof data === "number" ? data : 0;
    console.log("[listing-cache] ASK_ONLY FMV snapshots created: " + count);
    return count;
  } catch (e: any) {
    console.log("[listing-cache] fmv_from_cached_listings exception: " + (e.message || "unknown"));
    return 0;
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization");
    if (auth !== ("Bearer " + process.env.INGEST_SECRET_TOKEN)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Collection param: ?collection=nfl-all-day or defaults to nba-top-shot
    const collectionSlug = req.nextUrl.searchParams.get("collection") ?? "nba-top-shot";
    const chain = req.nextUrl.searchParams.get("chain") === "true";
    const config = getCollectionConfig(collectionSlug);
    console.log("[listing-cache] Collection: " + config.slug + " (" + config.flowtyEndpoint + ")");

    const startTime = Date.now();
    const pageOffsets: number[] = [];
    for (let i = 0; i < config.pagesToFetch; i++) pageOffsets.push(i * PAGE_SIZE);
    const pageResults = await Promise.all(pageOffsets.map(function(off) { return fetchFlowtyPage(off, config); }));
    const allNfts = pageResults.flat();
    console.log("[listing-cache] Fetched " + allNfts.length + " raw NFTs from Flowty (" + config.pagesToFetch + " pages)");

    if (allNfts.length === 0) {
      // Chain to next collection even on empty result
      if (config.chainNext && chain) {
        await fireNextPipelineStep("/api/listing-cache?collection=" + config.chainNext, chain);
      }
      return NextResponse.json({
        ok: true, message: "Flowty returned 0 - preserving existing cache",
        collection: config.slug,
        cached: 0, elapsed: Date.now() - startTime,
      });
    }

    const listings: any[] = [];
    for (let i = 0; i < allNfts.length; i++) {
      const mapped = mapFlowtyListing(allNfts[i], config);
      if (mapped) listings.push(mapped);
    }
    console.log("[listing-cache] Mapped " + listings.length + " valid listings");

    if (listings.length === 0) {
      if (config.chainNext && chain) {
        await fireNextPipelineStep("/api/listing-cache?collection=" + config.chainNext, chain);
      }
      return NextResponse.json({
        ok: true, message: "All listings filtered out during mapping",
        collection: config.slug,
        fetched: allNfts.length, cached: 0, elapsed: Date.now() - startTime,
      });
    }

    // Delete existing cached listings for this collection + source only
    const delResult = await supabase.from("cached_listings").delete()
      .eq("source", "flowty").eq("collection_id", config.collectionId);
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

    // ASK_ONLY FMV for collections without sales-based FMV (e.g. All Day)
    let askOnlyFmvCount = 0;
    if (config.askOnlyFmv) {
      askOnlyFmvCount = await runAskOnlyFmv(config.collectionId);
    }

    // Ask-proxy FMV backfill — creates LOW-confidence FMV snapshots for editions
    // with active listings but no existing FMV history (Top Shot only).
    let askProxyCreated = 0;
    let askProxyConsidered = 0;
    if (!config.askOnlyFmv) {
      try {
        const result = await backfillAskProxyFmv(listings);
        askProxyCreated = result.created;
        askProxyConsidered = result.editionsConsidered;
        console.log("[listing-cache] ask-proxy FMV: created " + askProxyCreated + " (considered " + askProxyConsidered + ")");
      } catch (e: any) {
        console.log("[listing-cache] ask-proxy FMV error: " + (e.message || "unknown"));
      }
    }

    // Chain to next collection if pipeline chaining is active
    if (config.chainNext && chain) {
      await fireNextPipelineStep("/api/listing-cache?collection=" + config.chainNext, chain);
    }

    return NextResponse.json({
      ok: true, collection: config.slug,
      fetched: allNfts.length, mapped: listings.length,
      cached: inserted, errors: insertErrors,
      askProxyCreated, askProxyConsidered,
      askOnlyFmvCount,
      elapsed: Date.now() - startTime,
    });
  } catch (e: any) {
    console.error("[listing-cache] FATAL: " + (e.message || "unknown"), e.stack || "");
    return NextResponse.json({ ok: false, error: e.message || "Unknown error" }, { status: 500 });
  }
}
