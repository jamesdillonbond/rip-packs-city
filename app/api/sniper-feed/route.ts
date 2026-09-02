import { NextResponse } from "next/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { getOrSetCache, deleteCache } from "@/lib/cache";
import { z } from "zod";
import { computePinnacleSniperFeed } from "@/lib/sniper/pinnacle";
// Per-serial weighting + display signal lives in a tested lib module.
import { sniperSerialMultiplier as serialMultiplier } from "@/lib/sniper/serial-multiplier";
import { feeNetDeal } from "@/lib/marketplace-fees";
import { applyFmvStalenessPenalty } from "@/lib/sniper/fmv-staleness";
import { leagueForSetName } from "@/lib/league";
import { loadTopshotFmvGuard, guardTopshotFmv } from "@/lib/fmv-display-guard";
// Pure listing/badge helpers live in a tested lib module.
import {
  parseListingPrice,
  extractBadgeSlugs,
  BADGE_LABELS,
  sortSniperDeals,
  mergeDedupeByEditionKey,
} from "@/lib/sniper/feed-helpers";
// Per-request source-failure accumulator. Every deal-bearing read below used to
// collapse to an empty list on failure, so the route answered 200 with
// `deals: []` and the UI concluded "No deals match your filters."
import { createSourceFailureSink, sniperFeedDegraded, type SourceFailureSink } from "@/lib/sniper/source-failures";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawListing {
  id: string;
  // Legacy Flowty/MomentListing fields
  flowRetailPrice?: { value: string };
  marketplacePrice?: number;
  setPlay?: {
    setID?: number;
    playID?: number;
    parallelID?: number;
    ID?: string;
    flowRetired?: boolean;
    circulations?: { circulationCount?: number; forSaleByCollectors?: number; locked?: number };
  };
  serialNumber?: number;
  setName?: string;
  momentTier?: string;
  momentTitle?: string;
  playerName?: string;
  teamAtMomentNbaId?: string;
  tags?: Array<{ id?: string; title?: string }>;
  assetPathPrefix?: string;
  isLocked?: boolean;
  storefrontListingID?: string;
  sellerAddress?: string;
  listingOrderID?: string;
  setSeriesNumber?: number;
  parallelSetPlay?: { setID: number; playID: number; parallelID?: number };
  // New MarketplaceEdition fields
  tier?: string;
  lowAsk?: number;
  parallelID?: number;
  parallelName?: string;
  editionListingCount?: number;
  set?: {
    id?: string;
    flowId?: string;
    flowSeriesNumber?: number;
    flowName?: string;
  };
  play?: {
    id?: string;
    flowID?: string;
    stats?: {
      playerName?: string;
      teamAtMoment?: string;
      jerseyNumber?: string;
      nbaSeason?: string;
    };
  };
  circulationCount: number;
  // Wall-clock listing timestamp from the upstream marketplace, when known.
  listedAt?: string | null;
}


// Shared honesty predicate for the two RPC-backed legs (AllDay fallback +
// Top Shot). A row whose fmv_usd is NULL/0/non-numeric has no fair value, and
// `Number(x) || 0` would have shipped it as a literal $0.00 on the board with a
// 0% discount. Drop the row; an em-dash would be honest, a $0.00 is not.
// (2026-07-25)
function hasUsableFmv(row: { fmv_usd?: number | string | null } | null | undefined): boolean {
  const f = row?.fmv_usd == null ? NaN : Number(row.fmv_usd);
  return Number.isFinite(f) && f > 0;
}

interface FmvRow {
  editionKey: string;
  // NULLABLE on purpose. fmv_snapshots.fmv_usd is nullable, and coercing an
  // absent FMV to a number here is how the ask-proxy guard downstream came to
  // invent a price for editions that have none (`null < 1` is true in JS).
  // Callers MUST null-check before doing arithmetic.
  fmv: number | null;
  aspUsd: number | null;
  floorPriceUsd: number | null;
  confidence: string;
  daysSinceSale: number | null;
  salesCount30d: number | null;
  packListingId: string | null;
  packName: string | null;
  // On-chain integer setID:playID — null when the editions row hasn't
  // been backfilled yet. This is the only valid source for ownership
  // matching against /api/owned-flow-ids.
  setIdOnchain: number | null;
  playIdOnchain: number | null;
  // Canonical edition art (editions.thumbnail_url) — preferred over the
  // constructed assets.nbatopshot.com URL, which 404s for editions the GQL
  // listing didn't key to media. ~99.7% populated for canonical TS editions.
  thumbnailUrl: string | null;
}

interface PackEvRow {
  pack_listing_id: string;
  pack_name: string;
  pack_price: number;
  ev: number;
  ev_ratio: number;
}

export interface SniperDeal {
  flowId: string;
  momentId: string;
  editionKey: string;
  // Integer-format setID:playID key (e.g. "218:8238") used for matching
  // against on-chain owned editions returned by /api/owned-flow-ids.
  // Null when the deal cannot be resolved to a Supabase edition row.
  intEditionKey: string | null;
  playerName: string;
  teamName: string;
  setName: string;
  seriesName: string;
  tier: string;
  parallel: string;
  parallelId: number;
  serial: number;
  circulationCount: number;
  askPrice: number;
  baseFmv: number;
  adjustedFmv: number;
  aspUsd: number | null;
  daysSinceSale: number | null;
  salesCount30d: number | null;
  discount: number;
  confidence: string;
  confidenceSource: string;
  hasBadge: boolean;
  badgeSlugs: string[];
  badgeLabels: string[];
  badgePremiumPct: number;
  serialMult: number;
  isSpecialSerial: boolean;
  isJersey: boolean;
  serialSignal: string | null;
  thumbnailUrl: string | null;
  isLocked: boolean;
  updatedAt: string | null;
  packListingId: string | null;
  packName: string | null;
  packEv: number | null;
  packEvRatio: number | null;
  buyUrl: string;
  listingResourceID: string | null;
  listingOrderID: string | null;
  storefrontAddress: string | null;
  // Marketplace tag — collection-native fetches use the per-collection slug.
  // UI consumes this for source labels.
  source: "topshot" | "allday" | "golazos" | "pinnacle";
  paymentToken: "DUC" | "FUT" | "FLOW" | "USDC_E";
  offerAmount: number | null;
  offerFmvPct: number | null;
  dealRating: number;
  isLowestAsk: boolean;
  // Fee-net math. Every price on this deal is GROSS, but the marketplace takes
  // its cut out of the SELLER's proceeds, so `discount` overstates what a flip
  // is actually worth. `netIfResold` is what you'd keep selling at adjustedFmv;
  // `netMarginPct` is that net against the ASK — the money at risk — not against
  // FMV, which would flatter it the same way the gross discount does. Null when
  // the collection has no VERIFIED published rate (never a guessed fee on a
  // money surface). Additive ONLY: it does not touch discount, adjustedFmv or
  // ranking. See lib/marketplace-fees.ts.
  netOfFees?: {
    feePct: number;
    netIfResold: number;
    netMarginUsd: number;
    netMarginPct: number;
    flipsNegative: boolean;
  } | null;
  // P1a: true when the FMV backing this deal is thin/uncertain or was clamped
  // to the edition's 90d max sale. The UI renders a "thin data — FMV uncertain"
  // caveat instead of headlining the discount. Top Shot only.
  lowConfidenceFmv?: boolean;
  // Phase 2 serial-adjusted FMV — the LiveToken-validated tier×circ #1/perfect
  // premium estimate. Additive intelligence ONLY: it never feeds adjustedFmv,
  // discount, or ranking. Non-null only for #1/perfect serials on a HIGH/MEDIUM
  // base (the sniper's own serialMult/adjustedFmv are unchanged).
  serialFmvEstimate?: {
    estimate_usd: number;
    multiplier: number;
    serial_bucket: "first" | "perfect";
    label: string;
  } | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TS_GQL = "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
};

const TS_PROXY_URL = process.env.TS_PROXY_URL ?? "";
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET ?? "";

const ALLDAY_PROXY_URL = process.env.ALLDAY_PROXY_URL ?? "";

// When the TS GQL pool returns fewer than this many listings, augment the
// feed with edition-level rows from get_topshot_sniper_deals (sourced from
// badge_editions, which topshot-fmv-populate keeps fresh). Threshold sized
// so a healthy GQL day (~150-220 listings) stays GQL-only, while an
// anomalously-empty day (0-25 listings) gets the RPC backfill.
const TS_GQL_SPARSE_THRESHOLD = 25;

const ALLDAY_MARKETPLACE_QUERY = `
  query searchMarketplaceEditions($after: String, $first: Int, $sortBy: MarketplaceEditionSortType) {
    searchMarketplaceEditions(input: { after: $after, first: $first, sortBy: $sortBy, filters: {} }) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges {
        node {
          editionFlowID
          lowestPrice
          averageSale
          totalListings
          numberOneSerial {
            id flowID
            momentNFTListing { id priceV2 { value } }
          }
          jerseySerial {
            id flowID
            momentNFTListing { id priceV2 { value } }
          }
          edition {
            id flowID tier
            maxMintSize currentMintSize numMomentsBurned
            badges { id slug title }
            play { metadata { playerFullName teamName } }
            set { name }
            series { name }
            parallel
          }
        }
      }
    }
  }
`;


const NBA_TEAMS: Record<string, string> = {
  "1610612737": "ATL", "1610612738": "BOS", "1610612739": "CLE", "1610612740": "NOP",
  "1610612741": "CHI", "1610612742": "DAL", "1610612743": "DEN", "1610612744": "GSW",
  "1610612745": "HOU", "1610612746": "LAC", "1610612747": "LAL", "1610612748": "MIA",
  "1610612749": "MIL", "1610612750": "MIN", "1610612751": "BKN", "1610612752": "NYK",
  "1610612753": "ORL", "1610612754": "IND", "1610612755": "PHI", "1610612756": "PHX",
  "1610612757": "POR", "1610612758": "SAC", "1610612759": "SAS", "1610612760": "OKC",
  "1610612761": "TOR", "1610612762": "UTA", "1610612763": "MEM", "1610612764": "WAS",
  "1610612765": "DET", "1610612766": "CHA",
};

const SERIES_NAMES: Record<number, string> = {
  0: "S1", 2: "S2", 3: "Sum 21", 4: "S3", 5: "S4", 6: "23-24", 7: "24-25", 8: "25-26",
};

const PARALLEL_NAMES: Record<number, string> = {
  0: "Base", 1: "Holo MMXX", 2: "Throwbacks", 3: "Camo", 4: "Metaverse",
  5: "Cosmic", 6: "Ember", 7: "Infinite", 8: "Sapphire", 9: "Ruby",
  10: "Gold", 11: "Super Rare", 12: "Platinum Ice", 13: "Black Ice",
  14: "Bronze", 15: "Silver", 16: "Metallic Gold LE", 17: "Legendary", 18: "Unique",
  19: "Unique", 20: "Unique",
};

// ─── Serial premium model ─────────────────────────────────────────────────────


// Display-time FMV staleness penalty (applyFmvStalenessPenalty) now lives in
// @/lib/sniper/fmv-staleness (imported above, unit-tested).

// ─── Serial-adjusted FMV estimate (Phase 2) ────────────────────────────────────
// Attaches the LiveToken-validated tier×circ #1/perfect premium to qualifying
// Top Shot deals via the SECDEF serial_fmv_estimate() RPC (the single source of
// truth — never recomputed here). Additive only: it does NOT touch adjustedFmv,
// discount, serialMult, or ranking. The qualifying subset (#1 / perfect-mint on
// a HIGH/MEDIUM base) is tiny per feed, so per-deal calls are cheap.
// Serial-FMV is fitted per collection; both Top Shot and NFL All Day now have a
// live model (compute_serial_fmv_multipliers/_power_model run + weekly-scheduled
// per collection, 2026-07-10). Golazos (too thin) and Pinnacle (separate engine)
// stay excluded here. Keyed off the deal's own source, not a hardcoded TS id.
const SERIAL_FMV_COLLECTION_BY_SOURCE: Record<string, string> = {
  topshot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  allday: "dee28451-5d62-409e-a1ad-a83f763ac070",
};

async function attachSerialFmvEstimates(supabase: SupabaseClient, deals: SniperDeal[]): Promise<void> {
  const targets = deals.filter(
    (d) =>
      SERIAL_FMV_COLLECTION_BY_SOURCE[d.source] != null &&
      d.baseFmv > 0 &&
      (d.serial === 1 || (d.circulationCount > 0 && d.serial === d.circulationCount))
  );
  if (!targets.length) return;

  // Resolve each target's edition UUID so the pooled multi-factor model can fire
  // (it keys set/jersey effects off the edition). Matched on the canonical
  // integer setID:playID (intEditionKey == editions.external_id for canonical
  // Top Shot editions). Unresolved -> p_edition_id null -> the RPC falls through
  // to the power-law/grid path (unchanged behaviour). AllDay has no pooled model,
  // so it stays on power-law whether or not its edition resolves.
  const editionIdByKey = new Map<string, string>(); // `${collectionId}|${intEditionKey}` -> edition uuid
  const keysByCollection = new Map<string, Set<string>>();
  for (const d of targets) {
    const coll = SERIAL_FMV_COLLECTION_BY_SOURCE[d.source];
    if (!coll || !d.intEditionKey) continue;
    if (!keysByCollection.has(coll)) keysByCollection.set(coll, new Set());
    keysByCollection.get(coll)!.add(d.intEditionKey);
  }
  await Promise.all(
    Array.from(keysByCollection.entries()).map(async ([coll, keys]) => {
      try {
        const { data: eds } = await (supabase as any)
          .from("editions")
          .select("id, external_id")
          .eq("collection_id", coll)
          .in("external_id", Array.from(keys));
        for (const row of (eds ?? []) as Array<{ id: string; external_id: string }>) {
          editionIdByKey.set(`${coll}|${row.external_id}`, row.id);
        }
      } catch {
        /* additive — unresolved editions just miss the pooled path */
      }
    })
  );

  await Promise.all(
    targets.map(async (d) => {
      try {
        const coll = SERIAL_FMV_COLLECTION_BY_SOURCE[d.source];
        const { data } = await (supabase as any).rpc("serial_fmv_estimate", {
          p_collection_id: coll,
          p_serial: d.serial,
          p_circulation: d.circulationCount,
          p_tier: d.tier,
          p_edition_fmv: d.baseFmv,
          p_confidence: d.confidence,
          p_edition_id: d.intEditionKey
            ? editionIdByKey.get(`${coll}|${d.intEditionKey}`) ?? null
            : null,
        });
        if (data && typeof data === "object" && data.estimate_usd != null) {
          d.serialFmvEstimate = {
            estimate_usd: Number(data.estimate_usd),
            multiplier: Number(data.multiplier),
            serial_bucket: data.serial_bucket,
            label: String(data.label ?? "estimated serial premium"),
          };
        }
      } catch {
        /* additive — a failed estimate just omits the badge */
      }
    })
  );
}

// ─── Top Shot GQL ─────────────────────────────────────────────────────────────

// ─── Top Shot listings from Supabase cache ────────────────────────────────────
// ts_listings is populated every 5 min by GitHub Actions via Flowty API.
// The marketplace/graphql endpoint is Cloudflare-protected from Vercel IPs,
// so we use the Supabase table as the primary TS feed source.

async function fetchTopShotPool(
  supabase: SupabaseClient,
  sink: SourceFailureSink
): Promise<{ listings: RawListing[]; tsCount: number }> {
  try {
    const { data, error } = await (supabase as any)
      .from("ts_listings")
      .select("listing_id, flow_id, set_id, play_id, serial_number, circulation_count, price_usd, player_name, set_name, moment_tier, series_number, is_locked, listed_at, ingested_at")
      .order("ingested_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("[sniper-feed] ts_listings fetch error:", error.message);
      sink.note("ts_listings");
      return { listings: [], tsCount: 0 };
    }

    const rows = data ?? [];

    // Resolve edition external_ids by matching player_name + set_name + series
    // against the editions + players tables. This gives us the edition key for FMV lookup.
    const editionKeyMap = await resolveEditionKeys(supabase, rows, sink);

    const listings: RawListing[] = rows.map((r: {
      listing_id: string;
      flow_id: string;
      set_id: number | null;
      play_id: number | null;
      serial_number: number;
      circulation_count: number;
      price_usd: number;
      player_name: string | null;
      set_name: string | null;
      moment_tier: string | null;
      series_number: number | null;
      is_locked: boolean | null;
      listed_at: string | null;
      ingested_at: string | null;
    }) => {
      const editionKey = editionKeyMap.get(r.flow_id);
      // Parse edition key "setId:playId" into setPlay IDs
      const parts = editionKey?.split(":") ?? [];
      const setID = parts[0] ?? "";
      const playID = parts[1] ?? "";
      return {
        id: r.flow_id,
        circulationCount: r.circulation_count ?? 0,
        serialNumber: r.serial_number ?? 0,
        marketplacePrice: r.price_usd,
        playerName: r.player_name ?? undefined,
        setName: r.set_name ?? undefined,
        momentTier: r.moment_tier ?? "COMMON",
        setSeriesNumber: r.series_number ?? 0,
        isLocked: r.is_locked ?? false,
        listingOrderID: r.listing_id,
        setPlay: { setID, playID },
        // Prefer the actual on-chain listing time; fall back to when our
        // ingest job first saw the row. Either is dramatically better than
        // "now", which would make every TS deal show as "Just now".
        listedAt: r.listed_at ?? r.ingested_at ?? null,
      };
    });

    console.log(`[sniper-feed] ts_listings: ${listings.length} rows, ${editionKeyMap.size} edition keys resolved`);
    return { listings, tsCount: listings.length };
  } catch (err) {
    console.error("[sniper-feed] ts_listings exception:", err instanceof Error ? err.message : String(err));
    sink.note("ts_listings");
    return { listings: [], tsCount: 0 };
  }
}

// Resolve ts_listings rows to edition external_ids by matching player + set + series
// against editions joined with players. Returns flowId → external_id map.
async function resolveEditionKeys(
  supabase: SupabaseClient,
  rows: Array<{ flow_id: string; player_name: string | null; set_name: string | null; series_number: number | null }>,
  sink: SourceFailureSink
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!rows.length) return result;

  // Build unique (player, set, series) tuples from ts_listings
  const tuples = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.player_name || !r.set_name) continue;
    const key = `${r.player_name.toLowerCase()}|${r.set_name.toLowerCase()}|${r.series_number ?? 0}`;
    const existing = tuples.get(key);
    if (existing) existing.push(r.flow_id);
    else tuples.set(key, [r.flow_id]);
  }

  if (!tuples.size) return result;

  const { data: editionRows, error } = await (supabase as any)
    .rpc("get_editions_for_sniper", { p_collection_id: null });

  if (error) {
    // Deal-bearing, not enrichment: without an edition key a listing has no
    // FMV to price against, so it is dropped downstream.
    console.error("[sniper-feed] edition RPC error:", error.message);
    sink.note("topshot-edition-keys");
    return result;
  }
  if (!editionRows?.length) {
    console.log("[sniper-feed] edition key resolve: 0 editions in DB");
    return result;
  }

  // Build lookup: "playerName|setName|series" → external_id from edition names
  // Edition name format: "PlayerName — SetName"
  const editionLookup = new Map<string, string>();
  for (const e of editionRows) {
    if (!e.name) continue;
    const dashIdx = e.name.indexOf(" \u2014 ");
    if (dashIdx < 0) continue;
    const playerName = e.name.slice(0, dashIdx);
    const setName = e.name.slice(dashIdx + 3);
    const lookupKey = `${playerName.toLowerCase()}|${setName.toLowerCase()}|${e.series}`;
    // Prefer keeping the first match (don't overwrite)
    if (!editionLookup.has(lookupKey)) {
      editionLookup.set(lookupKey, e.external_id);
    }
  }

  // Match ts_listings tuples to editions
  for (const [tupleKey, flowIds] of tuples) {
    const extId = editionLookup.get(tupleKey);
    if (extId) {
      for (const flowId of flowIds) {
        result.set(flowId, extId);
      }
    }
  }

  console.log(`[sniper-feed] edition key resolve: ${result.size}/${rows.length} listings matched`);
  return result;
}

// ─── NFL All Day marketplace GQL ──────────────────────────────────────────────
// searchMarketplaceEditions is the public marketplace feed. It can be fetched
// directly from Vercel (no Cloudflare block) or via a Worker proxy when
// ALLDAY_PROXY_URL is set. Returns edition-level floor data plus optional
// numberOneSerial / jerseySerial hooks for the #1 and Jersey-Serial specials.

interface AlldayGqlPage {
  edges: unknown[];
  endCursor: string | null;
  hasNextPage: boolean;
}

async function fetchAlldayGqlPage(after: string | null, sink: SourceFailureSink): Promise<AlldayGqlPage> {
  try {
    const url = ALLDAY_PROXY_URL || "https://nflallday.com/consumer/graphql";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ALLDAY_PROXY_URL && TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "searchMarketplaceEditions",
        query: ALLDAY_MARKETPLACE_QUERY,
        variables: { after, first: 100, sortBy: "LISTED_DATE_DESC" },
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`[sniper-feed] AD GQL FAILED: HTTP ${res.status} ${txt.slice(0, 200)}`);
      sink.note("allday-marketplace");
      return { edges: [], endCursor: null, hasNextPage: false };
    }
    const json = await res.json() as {
      data?: { searchMarketplaceEditions?: {
        edges?: unknown[];
        pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
      } };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors && json.errors.length) {
      console.error(`[sniper-feed] AD GQL FAILED: ${json.errors[0].message ?? "unknown GQL error"}`);
      sink.note("allday-marketplace");
      return { edges: [], endCursor: null, hasNextPage: false };
    }
    const search = json.data?.searchMarketplaceEditions;
    if (!search) {
      console.error(`[sniper-feed] AD GQL FAILED: missing searchMarketplaceEditions`);
      sink.note("allday-marketplace");
      return { edges: [], endCursor: null, hasNextPage: false };
    }
    return {
      edges: search.edges ?? [],
      endCursor: search.pageInfo?.endCursor ?? null,
      hasNextPage: !!search.pageInfo?.hasNextPage,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sniper-feed] AD GQL FAILED: ${msg}`);
    sink.note("allday-marketplace");
    return { edges: [], endCursor: null, hasNextPage: false };
  }
}

async function fetchAlldayPool(sink: SourceFailureSink): Promise<Array<Record<string, unknown>>> {
  const page1 = await fetchAlldayGqlPage(null, sink);
  let page2Edges: unknown[] = [];
  if (page1.hasNextPage && page1.endCursor) {
    const page2 = await fetchAlldayGqlPage(page1.endCursor, sink);
    page2Edges = page2.edges;
  }
  const allEdges = [...page1.edges, ...page2Edges].slice(0, 200);
  const nodes: Array<Record<string, unknown>> = [];
  for (const edge of allEdges) {
    const node = (edge as { node?: Record<string, unknown> } | null)?.node;
    if (node && typeof node === "object") nodes.push(node);
  }
  console.log(`[sniper-feed] AD pool: page1=${page1.edges.length} page2=${page2Edges.length} total=${nodes.length}`);
  return nodes;
}

// ─── Badge enrichment ────────────────────────────────────────────────────────
// Fetches the entire badge_editions table and matches in JS.
// Avoids .or() ilike filter syntax issues with apostrophes/accents in player names.
// Safe because badge_editions is a small table (hundreds of rows).

interface BadgeRow {
  external_id: string | null;
  player_name: string;
  play_tags: Array<{ id: string; title: string }> | null;
  set_play_tags: Array<{ id: string; title: string }> | null;
}

// Badge tags keyed by EDITION KEY (badge_editions.external_id, "setID:playID").
//
// 2026-08-01: this replaces fetchBadgesByPlayers(), which keyed the same rows
// by player_name. Two things were wrong with that:
//   1. It was the wrong GRAIN. Badges are a property of a PLAY, not a player -
//      keying by player would mark every edition of that player as badged.
//   2. Nothing consumed it. The returned map was awaited into `badgeMap` and
//      then used only in a console.log, so the fetch was pure waste while
//      `hasBadge` was computed from `l.tags` - a RawListing field that is
//      declared but NEVER ASSIGNED anywhere in this file. `hasBadge` was
//      therefore false for every Top Shot row, on both legs.
//
// external_id is unique in badge_editions and matches BOTH the ts_listings
// edition key and the RPC's moment_id, so a single map serves both legs.
//
// 🚨 THIS WAS A BARE `.select()` AND THE TABLE OUTGREW THE CAP. The comment here
// used to justify it as "safe because badge_editions is a small table (hundreds
// of rows)" against a measured 4,981. Measured again 2026-09-02: **9,471 Top
// Shot rows**, so PostgREST returned 1,000 of them — 10.6% — and `hasBadge` was
// false for ~89% of the editions that actually carry a badge. There is no error
// and no short read to notice: the fetch succeeds and the map is simply wrong.
// A count in a comment is a DATED SAMPLE, never a bound. Paged with .range()
// over a stable unique sort so the size stops mattering.
async function fetchBadgesByEditionKey(
  supabase: SupabaseClient
): Promise<Map<string, Array<{ id: string; title: string }>>> {
  // KEYSET, not OFFSET. external_id is unique within this collection (9,471 of
  // 9,471 distinct, verified live), so a `> cursor` walk is both deterministic
  // and O(n). Measured 2026-09-02 on the last page: keyset 1,935 buffers /
  // 118 ms vs the equivalent .range() page at 7,698 / 187 ms — an OFFSET page
  // re-walks every row before it, so a ten-page read pays that quadratically.
  const rows: BadgeRow[] = [];
  const PAGE = 1000;
  const MAX_PAGES = 200; // safety bound; the table is ~15k rows across collections
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = (supabase as any)
      .from("badge_editions")
      .select("external_id, player_name, play_tags, set_play_tags")
      .eq("collection_id", "95f28a17-224a-4025-96ad-adf8a4c63bfd")
      .order("external_id", { ascending: true })
      .limit(PAGE);
    if (cursor) q = q.gt("external_id", cursor);
    const { data, error } = await q;

    if (error) {
      console.error(`[sniper-feed] badge_editions fetch error @page ${page}: ${error.message}`);
      // Enrichment: a partial badge map costs chips and the badge premium, not
      // the listing itself — so this is not noted on the source-failure sink.
      break;
    }
    const rowsPage = (data ?? []) as BadgeRow[];
    rows.push(...rowsPage);
    if (rowsPage.length < PAGE) break;
    const next = rowsPage[rowsPage.length - 1]?.external_id;
    // No cursor means no progress — stop rather than re-read page 0 forever.
    if (!next || next === cursor) break;
    cursor = next;
  }
  const result = new Map<string, Array<{ id: string; title: string }>>();
  for (const row of rows) {
    const key = (row.external_id ?? "").trim();
    if (!key) continue;
    const tags = [...(row.play_tags ?? []), ...(row.set_play_tags ?? [])].filter(
      (t) => t && t.title
    );
    if (tags.length) result.set(key, tags);
  }

  console.log(
    `[sniper-feed] badge_editions rows=${rows.length} badged_editions=${result.size}`
  );
  return result;
}

// ─── Supabase FMV lookup ──────────────────────────────────────────────────────

async function fetchFmvBatch(
  supabase: SupabaseClient,
  integerKeys: string[]
): Promise<Map<string, FmvRow>> {
  if (!integerKeys.length) return new Map();

  const { data: editionRows } = await (supabase as any)
    .from("editions")
    .select("id, external_id, set_id_onchain, play_id_onchain, thumbnail_url")
    .in("external_id", integerKeys);

  if (!editionRows?.length) {
    console.log(`[sniper-feed] Supabase editions: 0 hits for ${integerKeys.length} integer keys`);
    return new Map();
  }

  const extToUuid = new Map<string, string>();
  const uuidToExt = new Map<string, string>();
  const onchainByExt = new Map<string, { setIdOnchain: number | null; playIdOnchain: number | null }>();
  const thumbnailByExt = new Map<string, string | null>();
  for (const row of editionRows as {
    id: string;
    external_id: string;
    set_id_onchain: number | null;
    play_id_onchain: number | null;
    thumbnail_url: string | null;
  }[]) {
    extToUuid.set(row.external_id, row.id);
    uuidToExt.set(row.id, row.external_id);
    onchainByExt.set(row.external_id, {
      setIdOnchain: row.set_id_onchain,
      playIdOnchain: row.play_id_onchain,
    });
    thumbnailByExt.set(row.external_id, row.thumbnail_url ?? null);
  }

  // Read fmv_current (DISTINCT-ON latest-per-edition, 1 row/edition) NOT raw
  // fmv_snapshots DESC — the latter overflows PostgREST's 1000-row cap (~35 history
  // rows/edition) and silently drops COLD editions, whose FMV then resolves null and
  // whose (possibly underpriced) listing is dropped from the deal board. Chunk the id
  // list at 1000 so a >1000-edition feed can't cap either. (asp_usd is exposed as
  // wap_usd by the view.)
  const fmvEditionIds = Array.from(extToUuid.values());
  const fmvRows: any[] = [];
  const FMV_CHUNK = 1000;
  for (let i = 0; i < fmvEditionIds.length; i += FMV_CHUNK) {
    const { data } = await (supabase as any)
      .from("fmv_current")
      .select("edition_id, fmv_usd, wap_usd, floor_price_usd, confidence, days_since_sale, sales_count_30d, computed_at")
      .in("edition_id", fmvEditionIds.slice(i, i + FMV_CHUNK));
    if (data?.length) fmvRows.push(...data);
  }

  if (!fmvRows.length) {
    console.log(`[sniper-feed] Supabase FMV: 0 snapshots for ${editionRows.length} editions`);
    return new Map();
  }

  const seen = new Set<string>();
  const map = new Map<string, FmvRow>();
  for (const row of fmvRows as {
    edition_id: string; fmv_usd: number | null; wap_usd: number | null;
    floor_price_usd: number | null; confidence: string;
    days_since_sale: number | null; sales_count_30d: number | null;
  }[]) {
    if (seen.has(row.edition_id)) continue;
    seen.add(row.edition_id);
    const extKey = uuidToExt.get(row.edition_id);
    if (!extKey) continue;
    const onchain = onchainByExt.get(extKey);
    map.set(extKey, {
      editionKey: extKey,
      // Keep NULL as null — never 0, never a substitute. An absent FMV must be
      // distinguishable from a genuine $0 downstream so the row can be dropped
      // instead of priced off something else.
      fmv: row.fmv_usd == null || !Number.isFinite(Number(row.fmv_usd))
        ? null
        : Number(row.fmv_usd),
      aspUsd: row.wap_usd,
      floorPriceUsd: row.floor_price_usd,
      confidence: (row.confidence ?? "low").toLowerCase(),
      daysSinceSale: row.days_since_sale,
      salesCount30d: row.sales_count_30d,
      packListingId: null,
      packName: null,
      setIdOnchain: onchain?.setIdOnchain ?? null,
      playIdOnchain: onchain?.playIdOnchain ?? null,
      thumbnailUrl: thumbnailByExt.get(extKey) ?? null,
    });
  }

  console.log(`[sniper-feed] Supabase FMV hits: ${map.size}/${integerKeys.length}`);
  return map;
}

async function fetchPackEvBatch(
  supabase: SupabaseClient,
  packIds: string[]
): Promise<Map<string, PackEvRow>> {
  if (!packIds.length) return new Map();
  const { data } = await (supabase as any)
    .from("pack_ev_cache")
    .select("pack_listing_id, pack_name, pack_price, ev, ev_ratio")
    .in("pack_listing_id", packIds);
  const map = new Map<string, PackEvRow>();
  for (const row of (data ?? []) as PackEvRow[]) map.set(row.pack_listing_id, row);
  return map;
}

// ─── Jersey number lookup ─────────────────────────────────────────────────────

async function fetchJerseyNumbers(
  supabase: SupabaseClient,
  playerNames: string[]
): Promise<Map<string, number>> {
  if (!playerNames.length) return new Map();

  // ⚠ Also over the cap. Measured 2026-09-02: 1,317 Top Shot players carry a
  // jersey number, so a bare .select() returned 1,000 and the last ~24% of
  // players never had their jersey-serial listings flagged. Same silent shape
  // as badge_editions above — a successful read of the wrong rows.
  const rows: Array<{ name: string; jersey_number: number }> = [];
  const PAGE = 1000;
  const MAX_ROWS = 100000;
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await (supabase as any)
      .from("players")
      .select("name, jersey_number")
      .eq("collection", "nba_top_shot")
      .not("jersey_number", "is", null)
      // players.id is the unique key; name is not guaranteed unique, so order
      // on id to keep the page boundary deterministic.
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const page = (data ?? []) as Array<{ name: string; jersey_number: number }>;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  if (!rows.length) return new Map();

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.name.toLowerCase().trim(), row.jersey_number);
  }
  console.log(`[sniper-feed] jersey_numbers: ${map.size} players loaded`);
  return map;
}

// Retired-moment nft_ids (excluded from the feed). Retirement is per-MOMENT
// (a retired edition retires all of its moments), so this set can run to many
// thousands of rows once retirements land — well past PostgREST's 1,000-row cap.
// A bare `.select()` would silently return only the first 1,000, leaking the
// rest back into the feed, so page with `.range()` over a stable sort until a
// short page signals the end. (Today `moments.retired` has 0 true rows, so this
// returns an empty set — the fix is purely defensive against that changing.)
async function fetchRetiredMomentIds(supabase: SupabaseClient): Promise<Set<string>> {
  const ids = new Set<string>();
  const PAGE = 1000;
  const MAX_ROWS = 500000; // safety bound (moments has ~572k rows total)
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await (supabase as any)
      .from("moments")
      .select("nft_id")
      .eq("retired", true)
      .order("nft_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const rows = (data ?? []) as Array<{ nft_id: string | null }>;
    for (const r of rows) if (r.nft_id != null) ids.add(String(r.nft_id));
    if (rows.length < PAGE) break;
  }
  return ids;
}

// ─── Input validation ─────────────────────────────────────────────────────────

const feedParamsSchema = z.object({
  minDiscount: z.coerce.number().min(0).max(100).default(0),
  rarity: z.string().default("all"),
  tier: z.string().default("all"), // alias for rarity — UI sends "tier"
  player: z.string().default(""), // post-fetch filter on playerName
  team: z.string().default("all"),
  badgeOnly: z.enum(["true", "false"]).default("false"),
  serial: z.string().default("all"),
  maxPrice: z.coerce.number().min(0).default(0),
  limit: z.coerce.number().min(1).max(500).default(0), // 0 = no limit
  sortBy: z.enum(["discount", "price_asc", "price_desc", "fmv_desc", "serial_asc", "listed_desc"]).default("listed_desc"),
  flowWalletOnly: z.enum(["true", "false"]).default("false"),
  editionKey: z.string().default(""), // edition depth filter (e.g. "26:504")
  collection: z.string().default("nba-top-shot"), // collection slug — nba-top-shot or nfl-all-day
  // Phase 2 alias: callers may pass collectionId instead of collection.
  // Handled below by overriding `collection` when collectionId is set.
  collectionId: z.string().optional(),
  league: z.enum(["NBA", "WNBA"]).optional(),
});

// ─── Route handler ────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams);
  const params = feedParamsSchema.parse(raw);
  // "tier" is a UI-friendly alias for "rarity"
  const effectiveRarity = params.tier !== "all" ? params.tier : params.rarity;
  const { minDiscount, team, sortBy, maxPrice, player, limit } = params;
  const badgeOnly = params.badgeOnly === "true";
  const serialFilter = params.serial;

  // Phase 2: collectionId takes precedence over legacy `collection` param.
  // Phase 5: also accept long-form (underscored) slugs as aliases for the
  // hyphenated form the rest of the app uses, so callers can pass either
  // `nba-top-shot` or `nba_top_shot` etc.
  const COLLECTION_ALIASES: Record<string, string> = {
    nba_top_shot: "nba-top-shot",
    nfl_all_day: "nfl-all-day",
    laliga_golazos: "laliga-golazos",
    disney_pinnacle: "disney-pinnacle",
    ufc_strike: "ufc",
    pinnacle: "disney-pinnacle",
  };
  const rawCollection = params.collectionId ?? params.collection;
  const collection = COLLECTION_ALIASES[rawCollection] ?? rawCollection;

  // Cache key based on all query params — same params = same response for 25s.
  const baseCacheKey = `sniper-feed:${JSON.stringify(params)}`;
  const CACHE_TTL = 25_000;

  function buildComputeFn() {
    if (collection === "nfl-all-day") {
      return () => computeAllDaySniperFeed({ minDiscount, rarity: effectiveRarity, team, maxPrice, sortBy });
    }
    if (collection === "disney-pinnacle") {
      // Pinnacle has its own data source (pinnacle_fmv_snapshots + direct
      // Pinnacle listings) and its own SniperDeal mapping shape — see
      // lib/sniper/pinnacle.ts.
      return async () => {
        const pin = await computePinnacleSniperFeed({
          variantFilter: effectiveRarity,
          maxPrice,
          minDiscount,
          playerFilter: player,
          sortBy,
        });
        return {
          count: pin.count,
          tsCount: 0,
          flowtyCount: pin.flowtyCount,
          lastRefreshed: pin.lastRefreshed,
          deals: pin.deals as unknown as SniperDeal[],
          // lib/sniper/pinnacle.ts throws on a failed read rather than
          // returning an empty board, so an empty result here IS a looked-and-
          // found-nothing. Nothing to note.
          sourcesFailed: [] as string[],
        };
      };
    }
    if (collection !== "nba-top-shot") {
      // Other collections (golazos, ufc) — Flowty cache retired May 2026; no
      // live source plumbed yet. Return empty rather than read stale rows.
      return async () => ({
        count: 0,
        tsCount: 0,
        flowtyCount: 0,
        lastRefreshed: new Date().toISOString(),
        deals: [] as SniperDeal[],
        // A deliberate no-source state, not a failed read: nothing is plumbed.
        sourcesFailed: [] as string[],
      });
    }
    return () => computeSniperFeed({ minDiscount, rarity: effectiveRarity, team, badgeOnly, serialFilter, maxPrice, sortBy, league: params.league });
  }

  type FeedResult = { count: number; tsCount: number; flowtyCount: number; lastRefreshed: string; deals: SniperDeal[]; cached?: boolean; sourcesFailed?: string[] };

  function applyOuterFilters(deals: SniperDeal[]): SniperDeal[] {
    let out = deals;
    if (params.editionKey) {
      const ek = params.editionKey;
      out = out.filter((d) => d.editionKey === ek || d.intEditionKey === ek);
    }
    if (player && player.trim()) {
      const lower = player.trim().toLowerCase();
      out = out.filter((d) => d.playerName.toLowerCase().includes(lower));
    }
    if (params.flowWalletOnly === "true") {
      out = out.filter((d) => d.paymentToken === "FLOW" || d.paymentToken === "USDC_E");
    }
    return out;
  }

  try {
    const result = (await getOrSetCache(baseCacheKey, CACHE_TTL, buildComputeFn())) as FeedResult;
    const sourcesFailed = result.sourcesFailed ?? [];
    // ⚠ Do not let a degraded build sit in the warm-lambda cache for the full
    // TTL — the next request would inherit this request's outage. The response
    // stays honest either way; this just shortens how long it lasts.
    if (sniperFeedDegraded(sourcesFailed)) deleteCache(baseCacheKey);
    const filteredDeals = applyOuterFilters(result.deals);

    // Final shaping uses the filtered set.
    let finalDeals = filteredDeals;
    if (limit > 0 && finalDeals.length > limit) {
      finalDeals = finalDeals.slice(0, limit);
    }

    // Fee-net enrichment. Applied HERE — once, after slicing — rather than in
    // each per-collection compute path, so every source (topshot / allday /
    // golazos / pinnacle) gets identical treatment and the cached compute
    // results stay fee-agnostic. Resale basis is adjustedFmv (the serial-aware
    // figure), because the thing being valued is this specific serial.
    finalDeals = finalDeals.map((d) => {
      const net = feeNetDeal(d.askPrice, d.adjustedFmv, collection);
      return net
        ? {
            ...d,
            netOfFees: {
              feePct: net.fee.pct,
              netIfResold: net.netIfResold,
              netMarginUsd: net.netMarginUsd,
              netMarginPct: net.netMarginPct,
              flipsNegative: net.flipsNegative,
            },
          }
        : { ...d, netOfFees: null };
    });

    return NextResponse.json(
      {
        ...result,
        deals: finalDeals,
        count: finalDeals.length,
        marketplaceAvailability: {
          topshot: true,
          flowty: false,
        },
        // Names the deal-bearing reads that failed on this build. Empty means
        // every source answered — so an empty `deals` is a real "nothing
        // matched", which is the only case the UI may say so in.
        sourcesFailed,
        degraded: sniperFeedDegraded(sourcesFailed),
      },
      {
        headers: { "Cache-Control": "public, max-age=0, s-maxage=90, stale-while-revalidate=60" },
      }
    );
  } catch (err: any) {
    console.error("[sniper-feed] unhandled error:", err?.message);
    return NextResponse.json(
      {
        error: "Feed unavailable",
        deals: [],
        count: 0,
        marketplaceAvailability: { topshot: true, flowty: false },
        sourcesFailed: ["sniper-feed"],
        degraded: true,
      },
      { status: 500 }
    );
  }
}

const ALLDAY_THUMBNAIL_BASE = "https://media.nflallday.com/editions/";

// ── All Day sniper feed via live marketplace GQL + fmv_snapshots join ─────
// Pulls the public searchMarketplaceEditions feed (two pages, up to 200 edges),
// cross-references an in-memory FMV map built from fmv_snapshots for the
// AllDay collection, and emits a SniperDeal per edition plus specials for
// #1 and Jersey Serial listings when present. Falls back to the RPC-based
// path when the live feed returns zero edges (proxy down, CF block, etc.).
async function computeAllDaySniperFeed(opts: {
  minDiscount: number; rarity: string; team: string; maxPrice: number; sortBy: string;
}) {
  const sink = createSourceFailureSink();
  const { minDiscount, rarity, team, maxPrice } = opts;
  const supabase = supabaseAdmin;
  const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";

  // 1. Build FMV map keyed on external_id (integer edition flow ID as string).
  //
  //    Reads `fmv_current`, NOT raw fmv_snapshots. The old read was
  //    `.eq(collection_id).order(computed_at DESC)` with no bound, justified by a
  //    comment that lived here claiming the AD snapshot table held only ~341
  //    rows. It does not: 306,895 AD snapshot rows over 6,190 editions.
  //    PostgREST caps every read at 1000 rows, so that query only ever saw the
  //    newest ~1000 SNAPSHOTS — a few hundred distinct editions. The "~341"
  //    figure in the comment was the truncation artifact, not the table size.
  //    This is the exact class __tests__/invariants-postgrest-cap.test.ts exists
  //    to prevent; it slipped through only because that guard's allowlist is
  //    per-FILE and this route was listed for its OTHER, genuinely .in()-bounded
  //    Top Shot read. (2026-07-25)
  //
  //    It matters more now than it did: since a listing with no FMV is excluded
  //    rather than priced off its own ask, a truncated map would silently drop
  //    most of the board instead of merely mislabelling it.
  //
  //    fmv_current is DISTINCT ON (edition_id) latest — <=1 row per edition, so
  //    no JS dedupe is needed — and it is paged with .range() because 6,190 rows
  //    still exceeds the cap. `.gt("fmv_usd", 0)` filters the ~1,075 editions
  //    whose newest snapshot is NULL server-side, so a map MISS and an unusable
  //    FMV are the same condition for buildDeal.
  const fmvMap = new Map<string, { fmv: number | null; confidence: string }>();
  try {
    const byEditionId = new Map<string, { fmv: number | null; confidence: string }>();
    const FMV_PAGE = 1000;
    for (let from = 0; ; from += FMV_PAGE) {
      const { data: fmvRows, error: fmvErr } = await (supabase as any)
        .from("fmv_current")
        .select("edition_id, fmv_usd, confidence")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .gt("fmv_usd", 0)
        // fmv_current is DISTINCT ON (edition_id), so edition_id is unique here.
        .order("edition_id", { ascending: true })
        .range(from, from + FMV_PAGE - 1);
      if (fmvErr) {
        console.error(`[sniper-feed] AD fmv_current error @${from}: ${fmvErr.message}`);
        // Deal-bearing: a listing with no FMV is EXCLUDED rather than priced off
        // its own ask, so a truncated map empties the board.
        sink.note("allday-fmv");
        break;
      }
      const page = (fmvRows ?? []) as Array<{ edition_id: string; fmv_usd: number | null; confidence: string }>;
      for (const row of page) {
        const raw = row.fmv_usd == null ? NaN : Number(row.fmv_usd);
        byEditionId.set(row.edition_id, {
          fmv: Number.isFinite(raw) ? raw : null,
          confidence: String(row.confidence ?? "LOW"),
        });
      }
      if (page.length < FMV_PAGE) break;
    }
    if (byEditionId.size > 0) {
      const editionIds = Array.from(byEditionId.keys());
      // Chunk IN() to stay well under PostgREST URL limits.
      for (let i = 0; i < editionIds.length; i += 500) {
        const chunk = editionIds.slice(i, i + 500);
        const { data: editionRows } = await (supabase as any)
          .from("editions")
          .select("id, external_id")
          .in("id", chunk);
        for (const e of (editionRows ?? []) as Array<{ id: string; external_id: string | null }>) {
          const entry = byEditionId.get(e.id);
          if (entry && e.external_id) fmvMap.set(String(e.external_id), entry);
        }
      }
    }
  } catch (err) {
    console.error(`[sniper-feed] AD FMV map build failed: ${err instanceof Error ? err.message : String(err)}`);
    sink.note("allday-fmv");
  }
  console.log(`[sniper-feed] AD FMV map size: ${fmvMap.size}`);

  // 2. Pull the live marketplace pool from NFL All Day public GQL.
  const nodes = await fetchAlldayPool(sink);

  // 3. Fallback to the RPC path when the live feed is empty — preserves the
  //    behavior that was shipping before this rewrite.
  if (nodes.length === 0) {
    console.log(`[sniper-feed] AD GQL empty — falling back to get_allday_sniper_deals RPC`);
    const { data: rows, error } = await (supabase as any).rpc("get_allday_sniper_deals", {
      p_min_discount: minDiscount,
      p_max_price: maxPrice,
      p_rarity: rarity === "all" ? "all" : rarity,
      p_team: team === "all" ? "all" : team,
      p_sort_by: opts.sortBy,
      p_limit: 200,
    });
    if (error) {
      console.error(`[sniper-feed] get_allday_sniper_deals error: ${error.message}`);
      sink.note("allday-deals-rpc");
      return { count: 0, tsCount: 0, flowtyCount: 0, lastRefreshed: new Date().toISOString(), deals: [], sourcesFailed: sink.failed };
    }
    // Same honesty rule as the live path: a row with no usable FMV cannot be
    // shown as a discount (see hasUsableFmv).
    const fallback: SniperDeal[] = (rows ?? []).filter(hasUsableFmv).map((r: any) => {
      const tier = String(r.tier ?? "COMMON").replace("MOMENT_TIER_", "");
      const confidence = String(r.confidence ?? "ASK_ONLY");
      const momentId = r.moment_id ? String(r.moment_id) : "";
      const thumbnailUrl = r.thumbnail_url ?? (momentId
        ? ALLDAY_THUMBNAIL_BASE + momentId + "/media/image?width=512&format=webp&quality=90"
        : null);
      return {
        flowId: r.flow_id ?? "",
        momentId,
        editionKey: "",
        intEditionKey: null,
        playerName: r.player_name ?? "",
        teamName: r.team_name ?? "",
        setName: r.set_name ?? "",
        seriesName: r.series_name ?? "",
        tier,
        parallel: "Base",
        parallelId: 0,
        serial: r.serial_number ?? 0,
        circulationCount: r.circulation_count ?? 0,
        askPrice: Number(r.ask_price) || 0,
        baseFmv: Number(r.fmv_usd) || 0,
        adjustedFmv: Number(r.fmv_usd) || 0,
        aspUsd: null,
        daysSinceSale: null,
        salesCount30d: null,
        discount: Number(r.discount_pct) || 0,
        confidence: confidence.toLowerCase(),
        confidenceSource: confidence === "ASK_ONLY" ? "ask_fallback" : "fmv_snapshots",
        hasBadge: false,
        badgeSlugs: [],
        badgeLabels: [],
        badgePremiumPct: 0,
        serialMult: 1,
        isSpecialSerial: false,
        isJersey: false,
        serialSignal: null,
        thumbnailUrl,
        isLocked: false,
        updatedAt: r.listed_at ?? null,
        packListingId: null,
        packName: null,
        packEv: null,
        packEvRatio: null,
        buyUrl: r.buy_url ?? "",
        listingResourceID: r.listing_resource_id ?? null,
        listingOrderID: null,
        storefrontAddress: null,
        source: "allday",
        paymentToken: "FLOW",
        offerAmount: null,
        offerFmvPct: null,
        dealRating: (Number(r.discount_pct) || 0) / 100,
        isLowestAsk: false,
      };
    });
    return {
      count: fallback.length,
      tsCount: 0,
      flowtyCount: fallback.length,
      lastRefreshed: new Date().toISOString(),
      deals: fallback,
      // Non-empty here still carries the GQL failure that sent us down this
      // path: the fallback is edition-level, so the board is real but partial.
      sourcesFailed: sink.failed,
    };
  }

  // 4. Shape GQL node → SniperDeal. buildDeal is reused for floor + specials.
  type EditionNode = {
    editionFlowID?: number | string;
    lowestPrice?: number | string | null;
    numberOneSerial?: { flowID?: number | string; momentNFTListing?: { priceV2?: { value?: string | number | null } } } | null;
    jerseySerial?: { flowID?: number | string; momentNFTListing?: { priceV2?: { value?: string | number | null } } } | null;
    edition?: {
      tier?: string | null;
      maxMintSize?: number | null;
      currentMintSize?: number | null;
      badges?: Array<{ id?: string; slug?: string; title?: string }> | null;
      play?: { metadata?: { playerFullName?: string | null; teamName?: string | null } | null } | null;
      set?: { name?: string | null } | null;
      series?: { name?: string | null } | null;
      parallel?: string | null;
    } | null;
  };

  interface DealOverrides {
    askPrice?: number;
    serial?: number;
    isSpecialSerial?: boolean;
    serialSignal?: string | null;
    flowId?: string;
    buyUrl?: string;
  }

  const buildDeal = (raw: Record<string, unknown>, overrides?: DealOverrides): SniperDeal | null => {
    const node = raw as EditionNode;
    const editionFlowID = String(node.editionFlowID ?? "");
    if (!editionFlowID) return null;
    const floorPrice = parseFloat(String(node.lowestPrice ?? "")) || 0;
    const askPrice = overrides?.askPrice ?? floorPrice;
    if (!askPrice || askPrice <= 0) return null;

    const tier = String(node.edition?.tier ?? "COMMON").replace("MOMENT_TIER_", "").toUpperCase();
    const fmvEntry = fmvMap.get(editionFlowID);
    // NO FMV -> NO ROW. This was `fmvEntry?.fmv || askPrice`, which quietly
    // substituted the ask for a missing (or 0) FMV: the listing then rendered
    // "FMV = ask" at a fake 0% discount, and — when an fmvEntry existed with a
    // NULL fmv_usd — it was even labelled confidenceSource "fmv_snapshots".
    // An absent FMV cannot be priced, so drop the listing rather than invent
    // a number. Note `||` vs `??`: a legitimate 0 is also not a usable FMV
    // here (nothing can be "40% off" a $0 fair value), so both are excluded.
    // (2026-07-25)
    const fmvValue = fmvEntry?.fmv ?? null;
    if (fmvValue == null || !Number.isFinite(fmvValue) || fmvValue <= 0) return null;
    const baseFmv = fmvValue;
    const adjustedFmv = baseFmv;
    const confidence = fmvEntry?.confidence?.toLowerCase() ?? "ask_only";
    const confidenceSource = "fmv_snapshots";
    const discount = askPrice < adjustedFmv
      ? Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10
      : 0;

    const badges = node.edition?.badges ?? [];
    const badgeSlugs = badges.map((b) => String(b?.slug ?? "")).filter(Boolean);
    const badgeLabels = badges.map((b) => String(b?.title ?? "")).filter(Boolean);
    const hasBadge = badgeSlugs.length > 0;

    const playerName = String(node.edition?.play?.metadata?.playerFullName ?? "");
    const teamName = String(node.edition?.play?.metadata?.teamName ?? "");
    const setName = String(node.edition?.set?.name ?? "");
    const seriesName = String(node.edition?.series?.name ?? "");
    const parallel = String(node.edition?.parallel ?? "Base");
    const circulationCount = Number(node.edition?.currentMintSize)
      || Number(node.edition?.maxMintSize)
      || 0;

    const thumbnailUrl = `https://media.nflallday.com/editions/${editionFlowID}/media/image?format=jpeg&width=512`;
    const buyUrl = overrides?.buyUrl
      ?? `https://nflallday.com/marketplace?filters=editionID:${editionFlowID}`;

    return {
      flowId: overrides?.flowId ?? editionFlowID,
      momentId: editionFlowID,
      editionKey: editionFlowID,
      intEditionKey: null,
      playerName,
      teamName,
      setName,
      seriesName,
      tier,
      parallel,
      parallelId: 0,
      serial: overrides?.serial ?? 0,
      circulationCount,
      askPrice,
      baseFmv,
      adjustedFmv,
      aspUsd: null,
      daysSinceSale: null,
      salesCount30d: null,
      discount,
      confidence,
      confidenceSource,
      // This GQL path never set lowConfidenceFmv at all, so an ask-derived FMV
      // rendered a confident discount % with no caveat. Flag ASK_ONLY here too.
      // NOTE: unlike the other two paths this one also never applies
      // guardTopshotFmv to baseFmv — that clamp CHANGES the discount number, so
      // it wants its own blast-radius measurement and is deliberately NOT added
      // here alongside a disclosure-only fix.
      lowConfidenceFmv: String(confidence ?? "").toUpperCase() === "ASK_ONLY",
      hasBadge,
      badgeSlugs,
      badgeLabels,
      badgePremiumPct: 0,
      serialMult: 1,
      isSpecialSerial: overrides?.isSpecialSerial ?? false,
      isJersey: false,
      serialSignal: overrides?.serialSignal ?? null,
      thumbnailUrl,
      isLocked: false,
      updatedAt: null,
      packListingId: null,
      packName: null,
      packEv: null,
      packEvRatio: null,
      buyUrl,
      listingResourceID: null,
      listingOrderID: null,
      storefrontAddress: null,
      source: "allday",
      paymentToken: "FLOW",
      offerAmount: null,
      offerFmvPct: null,
      dealRating: adjustedFmv > 0 ? Math.max(0, Number((1 - askPrice / adjustedFmv).toFixed(4))) : 0,
      isLowestAsk: false,
    };
  };

  const deals: SniperDeal[] = [];
  for (const raw of nodes) {
    const floor = buildDeal(raw);
    if (floor) deals.push(floor);

    const n1 = (raw as { numberOneSerial?: { flowID?: number | string; momentNFTListing?: { priceV2?: { value?: string | number | null } } } | null }).numberOneSerial;
    const n1Price = parseFloat(String(n1?.momentNFTListing?.priceV2?.value ?? ""));
    if (n1 && Number.isFinite(n1Price) && n1Price > 0) {
      const n1Flow = n1.flowID ? String(n1.flowID) : null;
      const d = buildDeal(raw, {
        askPrice: n1Price,
        serial: 1,
        isSpecialSerial: true,
        serialSignal: "#1",
        flowId: n1Flow ?? `${raw.editionFlowID}-1`,
        buyUrl: n1Flow ? `https://nflallday.com/moment/${n1Flow}` : undefined,
      });
      if (d) deals.push(d);
    }

    const js = (raw as { jerseySerial?: { flowID?: number | string; momentNFTListing?: { priceV2?: { value?: string | number | null } } } | null }).jerseySerial;
    const jsPrice = parseFloat(String(js?.momentNFTListing?.priceV2?.value ?? ""));
    if (js && Number.isFinite(jsPrice) && jsPrice > 0) {
      const jsFlow = js.flowID ? String(js.flowID) : null;
      const d = buildDeal(raw, {
        askPrice: jsPrice,
        isSpecialSerial: true,
        serialSignal: "Jersey Serial",
        flowId: jsFlow ?? `${raw.editionFlowID}-jersey`,
        buyUrl: jsFlow ? `https://nflallday.com/moment/${jsFlow}` : undefined,
      });
      if (d) deals.push(d);
    }
  }

  // 5. Filters — minDiscount, maxPrice, rarity, team.
  let filtered = deals;
  if (maxPrice > 0) filtered = filtered.filter((d) => d.askPrice <= maxPrice);
  if (rarity && rarity !== "all") {
    const want = rarity.toUpperCase();
    filtered = filtered.filter((d) => d.tier.toUpperCase() === want);
  }
  if (team && team !== "all") {
    filtered = filtered.filter((d) => d.teamName === team);
  }
  if (minDiscount > 0) filtered = filtered.filter((d) => d.discount >= minDiscount);

  // 6. Hard-coded price_asc sort — AllDay's API doesn't support LOW_ASK
  //    server-side, so we override whatever sortBy the UI sent.
  filtered.sort((a, b) => a.askPrice - b.askPrice);

  // 7. Mark lowest ask per edition so the UI can flag the floor listing.
  const lowestAskByEdition = new Map<string, number>();
  for (const d of filtered) {
    const current = lowestAskByEdition.get(d.editionKey);
    if (current === undefined || d.askPrice < current) lowestAskByEdition.set(d.editionKey, d.askPrice);
  }
  for (const d of filtered) {
    d.isLowestAsk = d.askPrice === lowestAskByEdition.get(d.editionKey);
  }

  const withFmv = filtered.filter((d) => d.confidenceSource === "fmv_snapshots").length;
  console.log(`[sniper-feed] AD DONE: total=${filtered.length} fmv_hits=${withFmv} fmv_map=${fmvMap.size}`);

  return {
    count: filtered.length,
    tsCount: 0,
    flowtyCount: filtered.length,
    lastRefreshed: new Date().toISOString(),
    deals: filtered,
    sourcesFailed: sink.failed,
  };
}

async function computeSniperFeed(opts: {
  minDiscount: number; rarity: string; team: string;
  badgeOnly: boolean; serialFilter: string; maxPrice: number; sortBy: string;
  league?: "NBA" | "WNBA";
}) {
  const { minDiscount, rarity, team, badgeOnly, serialFilter, maxPrice, sortBy } = opts;

  const sink = createSourceFailureSink();
  const supabase = supabaseAdmin;

  // P1a display guard — clamp base FMV to the edition's 90d max sale when it
  // overshoots (so a role-player common with a stale $42 FMV stops rendering a
  // fake -99% deal), and flag thin-data FMV. Loaded once per feed build.
  const fmvGuard = await loadTopshotFmvGuard(supabase as any).catch(() => new Map());

  // 1. Fetch TS listings (Flowty marketplace shut down May 2026 — TS GQL only).
  const { listings: tsListings, tsCount } = await fetchTopShotPool(supabase as any, sink);

  console.log(`[sniper-feed] fetched ts=${tsListings.length}`);

  // TS GQL sparse-pool augmentation. The TS GQL pool is anomalously small
  // some days (1-5 listings vs the healthy ~150-220), but get_topshot_sniper_deals
  // (sourced from badge_editions kept fresh by topshot-fmv-populate) has 2,400+
  // priced editions on hand. When GQL is below TS_GQL_SPARSE_THRESHOLD we
  // augment — not replace — the GQL pool with edition-level RPC rows so the
  // user still sees a populated feed. The merge happens after enrichment and
  // dedupes by editionKey so a deal that appears in both sources only shows
  // once (RPC wins on tie since it carries FMV that the GQL pool may lack).
  // Per-listing fields (serial_number, listing_resource_id) are NULL on RPC
  // rows because the RPC is edition-level, not per-moment.
  let rpcDeals: SniperDeal[] = [];
  if (tsListings.length < TS_GQL_SPARSE_THRESHOLD) {
    console.log(`[sniper-feed] TS GQL sparse (${tsListings.length} listings) — augmenting with get_topshot_sniper_deals RPC`);
    const { data: rpcRows, error: rpcErr } = await (supabase as any).rpc("get_topshot_sniper_deals", {
      p_min_discount: minDiscount,
      p_max_price: maxPrice,
      p_rarity: rarity === "all" ? "all" : rarity,
      p_team: team === "all" ? "all" : team,
      p_sort_by: sortBy,
      p_limit: 200,
    });
    if (rpcErr) {
      console.error(`[sniper-feed] get_topshot_sniper_deals error: ${rpcErr.message}`);
      // Reached only when the GQL pool is already sparse, so this failure is
      // the difference between a populated board and an apparently quiet one.
      sink.note("topshot-deals-rpc");
    } else {
      // No usable FMV -> no row. `Number(r.fmv_usd) || 0` below would emit
      // baseFmv/adjustedFmv 0 — a literal $0.00 fair value (see hasUsableFmv).
      rpcDeals = (rpcRows ?? []).filter(hasUsableFmv).map((r: any) => {
        const tier = String(r.tier ?? "COMMON");
        const confidence = String(r.confidence ?? "ASK_ONLY");
        const momentId = r.moment_id ? String(r.moment_id) : "";
        // P1a: clamp FMV to 90d max sale + flag thin data, then recompute the
        // discount off the honest figure (the RPC's discount_pct is vs raw FMV).
        const rpcAsk = Number(r.ask_price) || 0;
        const g = guardTopshotFmv(fmvGuard, momentId, Number(r.fmv_usd) || 0);
        const rpcFmv = g.effectiveFmv;
        const rpcDiscount = rpcFmv > 0 && rpcAsk < rpcFmv
          ? Math.round(((rpcFmv - rpcAsk) / rpcFmv) * 1000) / 10
          : 0;
        return {
          flowId: r.flow_id ?? "",
          momentId,
          editionKey: momentId,
          intEditionKey: /^[0-9]+:[0-9]+$/.test(momentId) ? momentId : null,
          playerName: r.player_name ?? "",
          teamName: r.team_name ?? "",
          setName: r.set_name ?? "",
          seriesName: r.series_name ?? "",
          tier,
          parallel: "Base",
          parallelId: 0,
          serial: r.serial_number ?? 0,
          circulationCount: r.circulation_count ?? 0,
          askPrice: rpcAsk,
          baseFmv: rpcFmv,
          adjustedFmv: rpcFmv,
          aspUsd: null,
          daysSinceSale: null,
          salesCount30d: null,
          discount: rpcDiscount,
          // ASK_ONLY FMV is 0.90 x a single seller's ask with no sales anchor,
          // so ANY discount against it is ask-vs-ask, not a real deal. The
          // display guard only carries editions it has already flagged (~17% of
          // ASK_ONLY rows), so keying the caveat off the guard alone let 83% of
          // them render a hard discount %. Matches app/api/market/route.ts.
          lowConfidenceFmv: g.lowConfidenceFmv || confidence.toUpperCase() === "ASK_ONLY",
          confidence: confidence.toLowerCase(),
          confidenceSource: confidence === "ASK_ONLY" ? "ask_fallback" : "fmv_snapshots",
          hasBadge: false,
          badgeSlugs: [],
          badgeLabels: [],
          badgePremiumPct: 0,
          serialMult: 1,
          isSpecialSerial: false,
          isJersey: false,
          serialSignal: null,
          thumbnailUrl: r.thumbnail_url ?? null,
          isLocked: false,
          updatedAt: r.listed_at ?? null,
          packListingId: null,
          packName: null,
          packEv: null,
          packEvRatio: null,
          buyUrl: r.buy_url ?? "",
          listingResourceID: r.listing_resource_id ?? null,
          listingOrderID: null,
          storefrontAddress: null,
          source: "topshot",
          paymentToken: "FLOW",
          offerAmount: null,
          offerFmvPct: null,
          dealRating: rpcDiscount / 100,
          isLowestAsk: false,
        };
      });
      console.log(`[sniper-feed] TS RPC augment: ${rpcDeals.length} edition-level rows`);
    }
  }

  // 2. Build integer edition keys for Supabase FMV lookup
  const tsEditionKeys = new Set<string>();
  for (const l of tsListings) {
    // Support both MarketplaceEdition shape (set.flowId + play.flowID) and legacy shape (setPlay.setID/playID)
    const setId = l.set?.flowId ?? l.setPlay?.setID;
    const playId = l.play?.flowID ?? l.setPlay?.playID;
    if (setId && playId) {
      const parallelId = l.parallelID ?? l.setPlay?.parallelID ?? 0;
      const key = parallelId > 0 ? `${setId}:${playId}::${parallelId}` : `${setId}:${playId}`;
      tsEditionKeys.add(key);
      tsEditionKeys.add(`${setId}:${playId}`);
    }
  }

  // 3. Collect unique player names for badge + jersey lookups
  const allPlayerNames = Array.from(new Set(
    tsListings.map(l => l.play?.stats?.playerName ?? l.playerName ?? "").filter(Boolean)
  ));

  // 4. Fire all Supabase lookups in parallel
  const [fmvMap, badgeMap, jerseyMap, retiredIds] = await Promise.all([
    fetchFmvBatch(supabase, Array.from(tsEditionKeys)).catch(() => new Map<string, any>()),
    fetchBadgesByEditionKey(supabase).catch(
      () => new Map<string, Array<{ id: string; title: string }>>()
    ),
    fetchJerseyNumbers(supabase, allPlayerNames).catch(() => new Map<string, string>()),
    fetchRetiredMomentIds(supabase).catch(() => new Set<string>()),
  ]);
  console.log(`[sniper-feed] retiredIds size=${retiredIds.size}`);

  // 4b. Enrich the RPC augment rows with REAL badges, then apply the
  // badge/serial predicates to them.
  //
  // These rows are built above, BEFORE badgeMap exists, so they were emitted
  // with `hasBadge: false` placeholders - and, because they are merged in at
  // step 6b AFTER the step-5 enrichment loop, they never passed through that
  // loop's `if (badgeOnly && !hasBadge) continue`. So "Badges only" did not
  // filter them at all.
  //
  // That is the whole bug: ts_listings is a DEAD table (1 row, frozen
  // 2026-05-15), so `tsListings.length` is always < TS_GQL_SPARSE_THRESHOLD,
  // the RPC augment fires on every request, and these rows ARE the Top Shot
  // board. Checking "Badges only" therefore dropped the single ts_listings row
  // and passed ~200 unfiltered, all-flagged-unbadged RPC rows straight through
  // - a silent no-op returning exclusively un-badged moments.
  //
  // badge_editions.external_id === the RPC's moment_id, so the same map used
  // by the ts_listings leg applies here. Verified live: 200/200 rows join and
  // 77 carry a real badge, so `badgeOnly` now yields a populated, honest board
  // rather than 0 or 200.
  if (rpcDeals.length > 0) {
    rpcDeals = rpcDeals.map((d) => {
      const tags = badgeMap.get(d.editionKey) ?? badgeMap.get(d.momentId);
      if (!tags?.length) return d;
      const slugs = extractBadgeSlugs(tags);
      if (!slugs.length) return d;
      return {
        ...d,
        hasBadge: true,
        badgeSlugs: slugs,
        badgeLabels: slugs.map((s) => BADGE_LABELS[s] ?? s),
      };
    });
    if (badgeOnly) rpcDeals = rpcDeals.filter((d) => d.hasBadge);
    // get_topshot_sniper_deals is EDITION-level: serial_number is NULL on
    // every row (verified live 200/200), so an edition row can never satisfy a
    // per-serial predicate. Dropping them is the honest answer - passing them
    // through is what made "Special serials" a no-op. The UI no longer offers
    // this control, but the query param is still reachable directly.
    if (serialFilter === "special" || serialFilter === "jersey") rpcDeals = [];
  }

  // 5. Enrich TS listings
  const tsDeals: SniperDeal[] = [];
  for (const l of tsListings) {
    const askPrice = parseListingPrice(l);
    if (!askPrice || askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tierRaw = (l.tier ?? l.momentTier ?? "COMMON").replace("MOMENT_TIER_", "").toUpperCase();
    if (rarity !== "all" && tierRaw.toUpperCase() !== rarity.toUpperCase()) continue;

    // Support both MarketplaceEdition (set.flowId/play.flowID) and legacy (setPlay.setID/playID)
    const setId = l.set?.flowId ?? l.setPlay?.setID;
    const playId = l.play?.flowID ?? l.setPlay?.playID;
    if (!setId || !playId) continue;
    const parallelId = l.parallelID ?? l.setPlay?.parallelID ?? 0;
    const editionKeyParallel = parallelId > 0 ? `${setId}:${playId}::${parallelId}` : null;
    const editionKeyBase = `${setId}:${playId}`;
    const editionKey = editionKeyParallel ?? editionKeyBase;

    // MarketplaceEdition is edition-level (no serial) — use 0 as placeholder
    const serial = l.serialNumber ?? 0;
    const circ = l.circulationCount ?? l.setPlay?.circulations?.circulationCount ?? 1000;

    const playerNameRaw = l.play?.stats?.playerName ?? l.playerName ?? l.momentTitle ?? "Unknown";
    const jerseyRaw = jerseyMap.get(playerNameRaw.toLowerCase().trim()) ?? null;
    const jerseyNumber = jerseyRaw !== null ? Number(jerseyRaw) || null : null;
    const { mult: serialMult, signal: serialSignal, isSpecial: isSpecialSerial } =
      serialMultiplier(serial, circ, jerseyNumber);
    const isJersey = jerseyNumber !== null && serial === jerseyNumber;

    const teamName = NBA_TEAMS[l.play?.stats?.teamAtMoment ?? l.teamAtMomentNbaId ?? ""] ?? l.play?.stats?.teamAtMoment ?? "";
    if (team !== "all" && teamName !== team) continue;

    // Badges come from badge_editions keyed by edition key. `l.tags` is a
    // declared-but-never-assigned RawListing field, so the old
    // extractBadgeSlugs(l.tags) returned [] for every row - which meant
    // "Badges only" dropped 100% of this leg. Kept as a last-resort fallback
    // in case a future pool source does populate it.
    const badgeTags =
      (editionKeyParallel ? badgeMap.get(editionKeyParallel) : null) ??
      badgeMap.get(editionKeyBase) ??
      l.tags;
    const badgeSlugs = extractBadgeSlugs(badgeTags);
    const hasBadge = badgeSlugs.length > 0;
    if (badgeOnly && !hasBadge) continue;
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey" && !isJersey) continue;

    const fmvRow = (editionKeyParallel ? fmvMap.get(editionKeyParallel) : null)
      ?? fmvMap.get(editionKeyBase)
      ?? null;

    if (!fmvRow) continue;

    // A missing FMV is NOT a small FMV. The ask-proxy guard below reads
    // `baseFmv < 1`, and in JavaScript `null < 1` is TRUE — so before this
    // check an edition with no FMV at all fell into the ask-proxy branch and
    // got a fabricated price of floorPriceUsd * 0.90. Drop the row instead:
    // absent data must never be rendered as a number. (2026-07-25)
    if (fmvRow.fmv == null || !Number.isFinite(fmvRow.fmv)) continue;

    let baseFmv: number = fmvRow.fmv;
    const confidence = fmvRow.confidence;
    let confidenceSource = "supabase";

    // Ask-proxy fallback: if FMV is effectively zero with LOW confidence,
    // use floor ask price * 0.90 as a usable price signal. Only reachable for
    // a REAL number now (a genuine 0/near-0 snapshot), never for a NULL.
    if (
      (confidence === "LOW" || confidence === "low") &&
      baseFmv < 1 &&
      fmvRow.floorPriceUsd &&
      fmvRow.floorPriceUsd > 0
    ) {
      baseFmv = fmvRow.floorPriceUsd * 0.90;
      confidenceSource = "ask_proxy";
    }

    // P1a: clamp the edition base FMV to its 90d max sale when it overshoots
    // (applied to base, NOT adjustedFmv, so legit #1/last-serial premiums are
    // preserved). Fake bargains then fall below the ask and drop out at the
    // discount filter below; thin-data survivors get flagged for the caveat.
    const guarded = guardTopshotFmv(fmvGuard, editionKey, baseFmv);
    baseFmv = guarded.effectiveFmv;

    let adjustedFmv = baseFmv * serialMult;
    // Staleness penalty (display-only — does NOT mutate fmv_snapshots).
    // The recalc weights WAP by days_since_sale decay, but a single sale
    // from 20+ days ago can still leave FMV inflated relative to the
    // current market. Apply a 30% haircut when the only data point is
    // both old (>14d) and lonely (<=1 sale in the last 30d). For LOW
    // confidence editions where the lone sale is older than a month,
    // collapse FMV to the ask price so the deal renders at 0% discount
    // instead of a fake bargain.
    adjustedFmv = applyFmvStalenessPenalty(adjustedFmv, askPrice, confidence, fmvRow.daysSinceSale, fmvRow.salesCount30d);
    if (askPrice >= adjustedFmv) continue;
    const discount = Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;
    const dealRating = adjustedFmv > 0 ? Math.max(0, Number((1 - askPrice / adjustedFmv).toFixed(4))) : 0;
    if (discount < minDiscount) continue;

    // Prefer the canonical editions.thumbnail_url (reliable, ~99.7% populated)
    // over the GQL asset-path / constructed media URL, which 404s when the
    // listing didn't resolve to media. Falls back to the constructed URL.
    const thumbnailUrl = fmvRow.thumbnailUrl
      ?? (l.assetPathPrefix
        ? `${l.assetPathPrefix}Hero_Black_2880_2880.jpg`
        : `https://assets.nbatopshot.com/media/${l.id}?width=256`);

    const tsListingResourceId = l.listingOrderID ?? l.storefrontListingID ?? null;
    // Always link to the per-moment page (verified-working). The old
    // `/marketplace/editions/<setID>/<playID>` format (on-chain integer ids)
    // 404s on Top Shot — see handoff-2026-06-17-alert-buy-link-url-correction.md.
    // Unlike the edition-level deal board, the sniper feed has the moment id, so
    // `/moment/<id>` is both valid and more precise (lands on the exact listing).
    const tsBuyUrl = `https://nbatopshot.com/moment/${l.id}`;

    // Bare integer setID:playID for on-chain ownership matching. The ONLY
    // valid source is set_id_onchain/play_id_onchain on the editions row.
    // The TS GQL setId/playId values are NOT on-chain integers — do not use
    // them. Falls back to parsing external_id when it happens to already be
    // in integer form (e.g. "90:4060").
    let intEditionKey: string | null = null;
    if (fmvRow.setIdOnchain != null && fmvRow.playIdOnchain != null) {
      intEditionKey = `${fmvRow.setIdOnchain}:${fmvRow.playIdOnchain}`;
    } else if (fmvRow.editionKey && /^\d+:\d+(::\d+)?$/.test(fmvRow.editionKey)) {
      intEditionKey = fmvRow.editionKey.split("::")[0];
    }

    tsDeals.push({
      flowId: String(l.id),
      momentId: String(l.id),
      editionKey,
      intEditionKey,
      playerName: playerNameRaw,
      teamName,
      setName: l.set?.flowName ?? l.setName ?? "",
      seriesName: (() => { const sn = l.set?.flowSeriesNumber ?? l.setSeriesNumber; return sn != null ? (SERIES_NAMES[sn] ?? "") : ""; })(),
      tier: tierRaw,
      parallel: PARALLEL_NAMES[parallelId] ?? (parallelId > 0 ? `Parallel #${parallelId}` : "Base"),
      parallelId,
      serial,
      circulationCount: circ,
      askPrice,
      baseFmv,
      adjustedFmv,
      aspUsd: fmvRow.aspUsd,
      daysSinceSale: fmvRow.daysSinceSale,
      salesCount30d: fmvRow.salesCount30d,
      discount,
      confidence,
      confidenceSource,
      hasBadge,
      badgeSlugs,
      badgeLabels: badgeSlugs.map(s => BADGE_LABELS[s] ?? s),
      badgePremiumPct: 0,
      serialMult,
      isSpecialSerial,
      isJersey,
      serialSignal,
      thumbnailUrl,
      isLocked: l.isLocked ?? false,
      updatedAt: l.listedAt ?? new Date().toISOString(),
      packListingId: fmvRow.packListingId,
      packName: fmvRow.packName,
      packEv: null,
      packEvRatio: null,
      buyUrl: tsBuyUrl,
      listingResourceID: tsListingResourceId,
      listingOrderID: l.listingOrderID ?? null,
      storefrontAddress: l.sellerAddress ?? null,
      source: "topshot",
      paymentToken: "DUC",
      offerAmount: null,
      offerFmvPct: null,
      dealRating,
      isLowestAsk: false,
      // See the RPC path above — ask-derived FMV never anchors a real discount.
      lowConfidenceFmv:
        guarded.lowConfidenceFmv || String(confidence ?? "").toUpperCase() === "ASK_ONLY",
    });
  }

  console.log(`[sniper-feed] built ts=${tsDeals.length}`);

  // 6. Exclude retired moments.
  let allDeals: SniperDeal[] = tsDeals.filter((d) => !retiredIds.has(d.flowId));

  // 6b. Merge RPC augment rows when GQL was sparse. Dedup by editionKey so
  // a deal present in both sources only shows once. RPC entries come first
  // and win on collision since they carry the FMV the GQL pool may lack.
  if (rpcDeals.length > 0) {
    const merged = mergeDedupeByEditionKey(rpcDeals, allDeals);
    console.log(`[sniper-feed] TS merge: rpc=${rpcDeals.length} gql=${allDeals.length} → ${merged.length}`);
    allDeals = merged;
  }

  // 7. Mark the lowest ask per edition so the UI can flag the floor listing.
  const lowestAskByEdition = new Map<string, number>();
  for (const d of allDeals) {
    const key = d.editionKey || d.flowId;
    const current = lowestAskByEdition.get(key);
    if (current === undefined || d.askPrice < current) {
      lowestAskByEdition.set(key, d.askPrice);
    }
  }
  for (const d of allDeals) {
    const key = d.editionKey || d.flowId;
    d.isLowestAsk = d.askPrice === lowestAskByEdition.get(key);
  }

  // 8. Pack EV enrichment
  const packIds = Array.from(new Set(allDeals.map(d => d.packListingId).filter(Boolean) as string[]));
  const packMap = await fetchPackEvBatch(supabase, packIds);
  for (const d of allDeals) {
    if (d.packListingId) {
      const pev = packMap.get(d.packListingId);
      if (pev) { d.packEv = pev.ev; d.packEvRatio = pev.ev_ratio; }
    }
  }

  // 9. League filter (NBA / WNBA) — Top Shot only.
  if (opts.league) {
    const before = allDeals.length;
    allDeals = allDeals.filter((d) => leagueForSetName(d.setName) === opts.league);
    console.log(`[sniper-feed] league=${opts.league} filtered ${before} → ${allDeals.length}`);
  }

  // 10. Sort
  const sorted = sortSniperDeals(allDeals, sortBy);

  // 11. Attach the serial-adjusted FMV estimate to #1/perfect deals (additive).
  await attachSerialFmvEstimates(supabase, sorted);

  const badgedCount = sorted.filter(d => d.hasBadge).length;
  console.log(
    `[sniper-feed] DONE ts=${tsDeals.length} total=${sorted.length} ` +
    `badged=${badgedCount} fmv_hits=${fmvMap.size} badged_editions=${badgeMap.size}`
  );

  return {
    count: sorted.length,
    // Surface the actual displayed count so the UI badge matches what users
    // see. After the RPC augment + dedup + filters, this differs from the
    // raw ts_listings count returned by fetchTopShotPool.
    tsCount: sorted.length,
    flowtyCount: 0,
    lastRefreshed: new Date().toISOString(),
    deals: sorted,
    sourcesFailed: sink.failed,
  };
}