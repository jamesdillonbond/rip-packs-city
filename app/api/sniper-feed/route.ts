import { NextResponse } from "next/server";
import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchOpenOffers } from "@/lib/flowty/fetchOpenOffers";
import { getOrSetCache } from "@/lib/cache";
import { z } from "zod";

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
}

interface FmvRow {
  editionKey: string;
  fmv: number;
  wapUsd: number | null;
  floorPriceUsd: number | null;
  confidence: string;
  daysSinceSale: number | null;
  salesCount30d: number | null;
  packListingId: string | null;
  packName: string | null;
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
  wapUsd: number | null;
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
  source: "topshot" | "flowty";
  paymentToken: "DUC" | "FUT" | "FLOW" | "USDC_E";
  offerAmount: number | null;
  offerFmvPct: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the USD ask price from a RawListing, trying multiple field shapes. */
function parseListingPrice(l: RawListing): number {
  if (typeof l.marketplacePrice === "number" && l.marketplacePrice > 0) return l.marketplacePrice;
  if (l.flowRetailPrice?.value) {
    const parsed = parseFloat(l.flowRetailPrice.value);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  if (typeof l.lowAsk === "number" && l.lowAsk > 0) return l.lowAsk;
  return 0;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TS_GQL = "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
};

const TS_PROXY_URL = process.env.TS_PROXY_URL ?? "";
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET ?? "";

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

const BADGE_LABELS: Record<string, string> = {
  rookie_year: "Rookie Year", rookie_mint: "Rookie Mint", rookie_premiere: "Rookie Premiere",
  top_shot_debut: "TS Debut", three_star_rookie: "3★ Rookie", mvp: "MVP",
  championship_year: "Champ Year", rookie_of_the_year: "ROTY", fresh: "Fresh", autograph: "Auto",
  "Rookie Year": "Rookie Year", "Rookie Mint": "Rookie Mint", "Rookie Premiere": "Rookie Premiere",
  "Top Shot Debut": "TS Debut", "Three-Star Rookie": "3★ Rookie", "MVP Year": "MVP",
  "Championship Year": "Champ Year", "Rookie of the Year": "ROTY", "Fresh": "Fresh",
};
const KNOWN_BADGES = new Set(Object.keys(BADGE_LABELS));

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

const TEAM_ABBREVS: Record<string, string> = {
  "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN",
  "Charlotte Hornets": "CHA", "Chicago Bulls": "CHI", "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN", "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW", "Houston Rockets": "HOU", "Indiana Pacers": "IND",
  "LA Clippers": "LAC", "Los Angeles Clippers": "LAC", "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM", "Miami Heat": "MIA", "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NOP", "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC", "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX", "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS", "Toronto Raptors": "TOR", "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
  "Atlanta Dream": "ATL", "Chicago Sky": "CHI", "Connecticut Sun": "CON",
  "Indiana Fever": "IND", "New York Liberty": "NYL", "Minnesota Lynx": "MIN",
  "Phoenix Mercury": "PHX", "Seattle Storm": "SEA", "Washington Mystics": "WAS",
  "Las Vegas Aces": "LVA", "Dallas Wings": "DAL", "Los Angeles Sparks": "LA",
  "Golden State Valkyries": "GS",
};

const SERIES_NAMES: Record<number, string> = {
  0: "Beta", 1: "S1", 2: "S2", 3: "S3", 4: "S4", 5: "S5", 6: "S6", 7: "S7", 8: "S8",
};

const PARALLEL_NAMES: Record<number, string> = {
  0: "Base", 1: "Holo MMXX", 2: "Throwbacks", 3: "Camo", 4: "Metaverse",
  5: "Cosmic", 6: "Ember", 7: "Infinite", 8: "Sapphire", 9: "Ruby",
  10: "Gold", 11: "Super Rare", 12: "Platinum Ice", 13: "Black Ice",
  14: "Bronze", 15: "Silver", 16: "Metallic Gold LE", 17: "Legendary", 18: "Unique",
  19: "Unique", 20: "Unique",
};

// ─── Serial premium model ─────────────────────────────────────────────────────

function serialMultiplier(
  serial: number,
  circulationCount: number,
  jerseyNumber: number | null
): { mult: number; signal: string | null; isSpecial: boolean } {
  if (serial === 1) return { mult: 8, signal: "#1", isSpecial: true };
  if (jerseyNumber !== null && serial === jerseyNumber)
    return { mult: 2.5, signal: `Jersey #${serial}`, isSpecial: true };
  if (serial === circulationCount)
    return { mult: 1.3, signal: `Last #${serial}`, isSpecial: true };
  return { mult: 1, signal: null, isSpecial: false };
}

// ─── Top Shot GQL ─────────────────────────────────────────────────────────────

// ─── Top Shot listings from Supabase cache ────────────────────────────────────
// ts_listings is populated every 5 min by GitHub Actions via Flowty API.
// The marketplace/graphql endpoint is Cloudflare-protected from Vercel IPs,
// so we use the Supabase table as the primary TS feed source.

async function fetchTopShotPool(
  supabase: SupabaseClient
): Promise<{ listings: RawListing[]; tsCount: number }> {
  try {
    const { data, error } = await (supabase as any)
      .from("ts_listings")
      .select("listing_id, flow_id, serial_number, circulation_count, price_usd, player_name, set_name, moment_tier, series_number, is_locked")
      .order("ingested_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("[sniper-feed] ts_listings fetch error:", error.message);
      return { listings: [], tsCount: 0 };
    }

    const rows = data ?? [];

    // Resolve edition external_ids by matching player_name + set_name + series
    // against the editions + players tables. This gives us the edition key for FMV lookup.
    const editionKeyMap = await resolveEditionKeys(supabase, rows);

    const listings: RawListing[] = rows.map((r: {
      listing_id: string;
      flow_id: string;
      serial_number: number;
      circulation_count: number;
      price_usd: number;
      player_name: string | null;
      set_name: string | null;
      moment_tier: string | null;
      series_number: number | null;
      is_locked: boolean | null;
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
      };
    });

    console.log(`[sniper-feed] ts_listings: ${listings.length} rows, ${editionKeyMap.size} edition keys resolved`);
    return { listings, tsCount: listings.length };
  } catch (err) {
    console.error("[sniper-feed] ts_listings exception:", err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
    return { listings: [], tsCount: 0 };
  }
}

// Resolve ts_listings rows to edition external_ids by matching player + set + series
// against editions joined with players. Returns flowId → external_id map.
async function resolveEditionKeys(
  supabase: SupabaseClient,
  rows: Array<{ flow_id: string; player_name: string | null; set_name: string | null; series_number: number | null }>
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

  // Fetch all editions — PostgREST caps at 1000 per request, so paginate
  const editionRows: Array<{ external_id: string; name: string | null; series: number }> = [];
  let page = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data: batch, error: batchErr } = await (supabase as any)
      .from("editions")
      .select("external_id, name, series")
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (batchErr) {
      console.error("[sniper-feed] edition fetch page error:", batchErr.message);
      break;
    }
    if (!batch?.length) break;
    editionRows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    page++;
  }
  const error = null;

  if (error) {
    console.error("[sniper-feed] edition key resolve error:", error.message);
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

// ─── Flowty helpers ───────────────────────────────────────────────────────────

// Vault type → short payment token mapping for Flowty listings
const VAULT_TO_PAYMENT_TOKEN: Record<string, "DUC" | "FUT" | "FLOW" | "USDC_E"> = {
  "A.ead892083b3e2c6c.DapperUtilityCoin.Vault": "DUC",
  "A.609e10301860b683.FlowUtilityToken.Vault": "FUT",
  "A.7e60df042a9c0868.FlowToken.Vault": "FLOW",
  "A.f1ab99c82dee3526.USDCFlow.Vault": "USDC_E",
};

interface FlowtyOrder {
  listingResourceID: string;
  storefrontAddress: string;
  flowtyStorefrontAddress?: string;
  salePrice: number;
  blockTimestamp: number;
  state?: string;
  salePaymentVaultType?: string;
}

interface FlowtyNftItem {
  id: string;
  orders?: FlowtyOrder[];
  card?: { title?: string; num?: number; max?: number };
  nftView?: { serial?: number; traits?: Array<{ name: string; value: string }> };
  valuations?: { blended?: { usdValue?: number }; livetoken?: { usdValue?: number } };
}

interface FlowtyListing {
  momentId: string;
  listingResourceID: string;
  storefrontAddress: string;
  price: number;
  livetokenFmv: number | null;
  blockTimestamp: number;
  playerName: string;
  serial: number;
  circulationCount: number;
  setName: string;
  teamName: string;
  tier: string;
  seriesNumber: number;
  subeditionId: number;
  isLocked: boolean;
  paymentToken: "DUC" | "FUT" | "FLOW" | "USDC_E";
}

// Multi-key trait lookup: tries each key name variant in order
const FLOWTY_TRAIT_MAP: Record<string, string[]> = {
  setName:      ["SetName", "setName", "Set Name", "set_name"],
  teamName:     ["TeamAtMoment", "teamAtMoment", "Team", "team"],
  tier:         ["Tier", "tier", "MomentTier", "momentTier"],
  seriesNumber: ["SeriesNumber", "seriesNumber", "Series Number", "series_number", "Series"],
  subedition:   ["Subedition", "subedition", "SubeditionID", "subeditionId"],
  locked:       ["Locked", "locked", "IsLocked", "isLocked"],
  fullName:     ["FullName", "fullName", "Full Name", "PlayerName", "playerName"],
};

function getTraitMulti(
  traits: Array<{ name: string; value: string }> | undefined,
  keys: string[]
): string {
  if (!traits) return "";
  for (const key of keys) {
    const found = traits.find((t) => t.name === key);
    if (found?.value) return found.value;
  }
  return "";
}

async function fetchFlowtyPage(from: number): Promise<FlowtyListing[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null, addresses: [],
        collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
        from, includeAllListings: true, limit: 24, onlyUnlisted: false,
        orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
        sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) { console.error(`[sniper-feed] Flowty HTTP ${res.status} from=${from}`); return []; }
    const json = await res.json();
    const rawItems: FlowtyNftItem[] = json?.nfts ?? json?.data ?? [];

    // Log actual trait keys from first item so we can verify field names in Vercel logs
    if (from === 0 && rawItems.length > 0) {
      const firstTraits = rawItems[0].nftView?.traits ?? [];
      console.log(`[sniper-feed] Flowty trait keys: ${firstTraits.map(t => t.name).join(", ")}`);
      // Also log a sample set/team value to verify enrichment
      const sampleSetName = getTraitMulti(firstTraits, FLOWTY_TRAIT_MAP.setName);
      const sampleTeam = getTraitMulti(firstTraits, FLOWTY_TRAIT_MAP.teamName);
      console.log(`[sniper-feed] Flowty sample setName="${sampleSetName}" teamName="${sampleTeam}"`);
    }

    console.log(`[sniper-feed] Flowty from=${from}: rawItems=${rawItems.length}`);
    const listings: FlowtyListing[] = [];
    let nullFmvCount = 0;
    for (const item of rawItems) {
      const order = item.orders?.find((o) => (o.salePrice ?? 0) > 0) ?? item.orders?.[0];
      if (!order?.listingResourceID) continue;
      if (order.salePrice <= 0) continue;
      const traits = item.nftView?.traits ?? [];
      const serial = item.card?.num ?? item.nftView?.serial ?? 0;
      const circ = item.card?.max ?? 0;
      const subStr = getTraitMulti(traits, FLOWTY_TRAIT_MAP.subedition);
      const livetokenFmv = item.valuations?.blended?.usdValue ?? item.valuations?.livetoken?.usdValue ?? null;
      if (!livetokenFmv || livetokenFmv <= 0) { nullFmvCount++; }

      // Normalize vault type to short payment token enum
      const paymentToken = VAULT_TO_PAYMENT_TOKEN[order.salePaymentVaultType ?? ""] ?? "DUC";

      listings.push({
        momentId: String(item.id),
        listingResourceID: order.listingResourceID,
        storefrontAddress: order.storefrontAddress ?? order.flowtyStorefrontAddress ?? "",
        price: order.salePrice,
        livetokenFmv: (livetokenFmv && livetokenFmv > 0) ? livetokenFmv : null,
        blockTimestamp: order.blockTimestamp ?? 0,
        playerName: item.card?.title ?? getTraitMulti(traits, FLOWTY_TRAIT_MAP.fullName) ?? "",
        serial,
        circulationCount: circ,
        setName: getTraitMulti(traits, FLOWTY_TRAIT_MAP.setName),
        teamName: getTraitMulti(traits, FLOWTY_TRAIT_MAP.teamName),
        tier: (getTraitMulti(traits, FLOWTY_TRAIT_MAP.tier) || "COMMON").toUpperCase(),
        seriesNumber: parseInt(getTraitMulti(traits, FLOWTY_TRAIT_MAP.seriesNumber) || "0", 10),
        subeditionId: subStr ? parseInt(subStr, 10) || 0 : 0,
        isLocked: getTraitMulti(traits, FLOWTY_TRAIT_MAP.locked) === "true",
        paymentToken,
      });
    }
    if (nullFmvCount > 0) {
      console.log(`[sniper-feed] Flowty from=${from}: ${nullFmvCount}/${rawItems.length} items have null/zero LiveToken FMV`);
    }
    return listings;
  } catch (err) {
    console.error(`[sniper-feed] Flowty from=${from} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function fetchAllFlowtyListings(): Promise<FlowtyListing[]> {
  const pages = await Promise.all([
    fetchFlowtyPage(0), fetchFlowtyPage(24),
    fetchFlowtyPage(48), fetchFlowtyPage(72),
    fetchFlowtyPage(96),
  ]);
  return pages.flat();
}

// ─── Badge enrichment for Flowty deals ───────────────────────────────────────
// Fetches the entire badge_editions table and matches in JS.
// Avoids .or() ilike filter syntax issues with apostrophes/accents in player names.
// Safe because badge_editions is a small table (hundreds of rows).

interface BadgeRow {
  player_name: string;
  badge_type: string;
}

async function fetchBadgesByPlayers(
  supabase: SupabaseClient,
  playerNames: string[]
): Promise<Map<string, string[]>> {
  if (!playerNames.length) return new Map();

  const { data, error } = await (supabase as any)
    .from("badge_editions")
    .select("player_name, badge_type");

  if (error) {
    console.error(`[sniper-feed] badge_editions fetch error: ${error.message}`);
    return new Map();
  }

  const rows = (data ?? []) as BadgeRow[];
  console.log(`[sniper-feed] badge_editions total rows: ${rows.length}`);

  // Build normalized lookup: lowercased player_name -> badge_type[]
  const allBadges = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.player_name.toLowerCase().trim();
    if (!allBadges.has(key)) allBadges.set(key, []);
    allBadges.get(key)!.push(row.badge_type);
  }

  // Match against the player names we care about
  const result = new Map<string, string[]>();
  let hitCount = 0;
  for (const name of playerNames) {
    const key = name.toLowerCase().trim();
    const badges = allBadges.get(key);
    if (badges?.length) {
      result.set(key, badges);
      hitCount++;
    }
  }

  console.log(`[sniper-feed] badge_editions: ${hitCount}/${playerNames.length} players matched`);
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
    .select("id, external_id")
    .in("external_id", integerKeys);

  if (!editionRows?.length) {
    console.log(`[sniper-feed] Supabase editions: 0 hits for ${integerKeys.length} integer keys`);
    return new Map();
  }

  const extToUuid = new Map<string, string>();
  const uuidToExt = new Map<string, string>();
  for (const row of editionRows as { id: string; external_id: string }[]) {
    extToUuid.set(row.external_id, row.id);
    uuidToExt.set(row.id, row.external_id);
  }

  const { data: fmvRows } = await (supabase as any)
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, wap_usd, floor_price_usd, confidence, days_since_sale, sales_count_30d, computed_at")
    .in("edition_id", Array.from(extToUuid.values()))
    .order("computed_at", { ascending: false });

  if (!fmvRows?.length) {
    console.log(`[sniper-feed] Supabase FMV: 0 snapshots for ${editionRows.length} editions`);
    return new Map();
  }

  const seen = new Set<string>();
  const map = new Map<string, FmvRow>();
  for (const row of fmvRows as {
    edition_id: string; fmv_usd: number; wap_usd: number | null;
    floor_price_usd: number | null; confidence: string;
    days_since_sale: number | null; sales_count_30d: number | null;
  }[]) {
    if (seen.has(row.edition_id)) continue;
    seen.add(row.edition_id);
    const extKey = uuidToExt.get(row.edition_id);
    if (!extKey) continue;
    map.set(extKey, {
      editionKey: extKey,
      fmv: row.fmv_usd,
      wapUsd: row.wap_usd,
      floorPriceUsd: row.floor_price_usd,
      confidence: (row.confidence ?? "low").toLowerCase(),
      daysSinceSale: row.days_since_sale,
      salesCount30d: row.sales_count_30d,
      packListingId: null,
      packName: null,
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

function extractBadgeSlugs(tags: Array<{ id?: string; title?: string }> | undefined): string[] {
  if (!tags) return [];
  return tags
    .map(t => {
      if (t.id && KNOWN_BADGES.has(t.id)) return t.id;
      if (t.title && KNOWN_BADGES.has(t.title)) return t.title;
      return null;
    })
    .filter((s): s is string => s !== null);
}

// ─── Jersey number lookup ─────────────────────────────────────────────────────

async function fetchJerseyNumbers(
  supabase: SupabaseClient,
  playerNames: string[]
): Promise<Map<string, number>> {
  if (!playerNames.length) return new Map();
  const { data, error } = await (supabase as any)
    .from("players")
    .select("name, jersey_number")
    .not("jersey_number", "is", null);

  if (error || !data?.length) return new Map();

  const map = new Map<string, number>();
  for (const row of data as { name: string; jersey_number: number }[]) {
    map.set(row.name.toLowerCase().trim(), row.jersey_number);
  }
  console.log(`[sniper-feed] jersey_numbers: ${map.size} players loaded`);
  return map;
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
});

// ─── Route handler ────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 25;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams);
  const params = feedParamsSchema.parse(raw);
  // "tier" is a UI-friendly alias for "rarity"
  const effectiveRarity = params.tier !== "all" ? params.tier : params.rarity;
  const { minDiscount, team, sortBy, maxPrice, player, limit } = params;
  const badgeOnly = params.badgeOnly === "true";
  const serialFilter = params.serial;

  // Cache key based on all query params — same params = same response for 25s
  const cacheKey = `sniper-feed:${JSON.stringify(params)}`;
  const CACHE_TTL = 25_000;

  let result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
    return computeSniperFeed({ minDiscount, rarity: effectiveRarity, team, badgeOnly, serialFilter, maxPrice, sortBy });
  }) as { count: number; tsCount: number; flowtyCount: number; lastRefreshed: string; deals: SniperDeal[]; cached?: boolean };

  // Post-fetch filter: player name (case-insensitive substring match)
  if (player && player.trim()) {
    const playerLower = player.trim().toLowerCase();
    const filtered = (result.deals as SniperDeal[]).filter((d) =>
      d.playerName.toLowerCase().includes(playerLower)
    );
    result = { ...result, deals: filtered, count: filtered.length };
  }

  // Post-fetch filter: Flow wallet only (FLOW or USDC_E payment tokens)
  if (params.flowWalletOnly === "true") {
    const filtered = (result.deals as SniperDeal[]).filter(
      (d) => d.paymentToken === "FLOW" || d.paymentToken === "USDC_E"
    );
    result = { ...result, deals: filtered, count: filtered.length };
  }

  // Post-fetch limit
  if (limit > 0 && result.deals.length > limit) {
    result = { ...result, deals: result.deals.slice(0, limit), count: limit };
  }

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, max-age=0, s-maxage=25, stale-while-revalidate=60" },
  });
}

async function computeSniperFeed(opts: {
  minDiscount: number; rarity: string; team: string;
  badgeOnly: boolean; serialFilter: string; maxPrice: number; sortBy: string;
}) {
  const { minDiscount, rarity, team, badgeOnly, serialFilter, maxPrice, sortBy } = opts;

  const supabase = supabaseAdmin;

  // 1. Fetch TS listings + Flowty in parallel
  const [{ listings: tsListings, tsCount }, flowtyListings] = await Promise.all([
    fetchTopShotPool(supabase as any),
    fetchAllFlowtyListings(),
  ]);

  console.log(`[sniper-feed] fetched ts=${tsListings.length} flowty=${flowtyListings.length}`);

  // 2. Build integer edition keys for Supabase FMV lookup
  //    Also build a flowId → editionKey map so Flowty deals can reuse TS edition keys
  const tsEditionKeys = new Set<string>();
  const flowIdToEditionKey = new Map<string, string>();
  for (const l of tsListings) {
    // Support both MarketplaceEdition shape (set.flowId + play.flowID) and legacy shape (setPlay.setID/playID)
    const setId = l.set?.flowId ?? l.setPlay?.setID;
    const playId = l.play?.flowID ?? l.setPlay?.playID;
    if (setId && playId) {
      const parallelId = l.parallelID ?? l.setPlay?.parallelID ?? 0;
      const key = parallelId > 0 ? `${setId}:${playId}::${parallelId}` : `${setId}:${playId}`;
      tsEditionKeys.add(key);
      tsEditionKeys.add(`${setId}:${playId}`);
      flowIdToEditionKey.set(String(l.id), `${setId}:${playId}`);
    }
  }

  // 3. Collect unique player names for badge + jersey lookups
  const allPlayerNames = Array.from(new Set([
    ...flowtyListings.map(l => l.playerName).filter(Boolean),
    ...tsListings.map(l => l.play?.stats?.playerName ?? l.playerName ?? "").filter(Boolean),
  ]));

  // 4. Fire all Supabase lookups in parallel (including jersey numbers + retired moments)
  const [fmvMap, badgeMap, offerMap, jerseyMap, retiredResult] = await Promise.all([
    fetchFmvBatch(supabase, Array.from(tsEditionKeys)),
    fetchBadgesByPlayers(supabase, allPlayerNames),
    fetchOpenOffers().catch(() => new Map<string, { amount: number; fmv: number | null }>()),
    fetchJerseyNumbers(supabase, allPlayerNames),
    (supabase as any).from("moments").select("nft_id").eq("retired", true),
  ]);
  const retiredIds = new Set<string>(
    (retiredResult?.data ?? []).map((r: { nft_id: string }) => String(r.nft_id))
  );
  console.log(`[sniper-feed] offerMap size=${offerMap.size} retiredIds size=${retiredIds.size}`);

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
    const jerseyNumber = jerseyMap.get(playerNameRaw.toLowerCase().trim()) ?? null;
    const { mult: serialMult, signal: serialSignal, isSpecial: isSpecialSerial } =
      serialMultiplier(serial, circ, jerseyNumber);
    const isJersey = jerseyNumber !== null && serial === jerseyNumber;

    const teamName = NBA_TEAMS[l.play?.stats?.teamAtMoment ?? l.teamAtMomentNbaId ?? ""] ?? l.play?.stats?.teamAtMoment ?? "";
    if (team !== "all" && teamName !== team) continue;

    const badgeSlugs = extractBadgeSlugs(l.tags);
    const hasBadge = badgeSlugs.length > 0;
    if (badgeOnly && !hasBadge) continue;
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey" && !isJersey) continue;

    const fmvRow = (editionKeyParallel ? fmvMap.get(editionKeyParallel) : null)
      ?? fmvMap.get(editionKeyBase)
      ?? null;

    if (!fmvRow) continue;

    const baseFmv = fmvRow.fmv;
    const confidence = fmvRow.confidence;
    const confidenceSource = "supabase";
    const adjustedFmv = baseFmv * serialMult;
    const discount = askPrice >= adjustedFmv
      ? 0
      : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;
    if (discount < minDiscount) continue;

    const thumbnailUrl = l.assetPathPrefix
      ? `${l.assetPathPrefix}Hero_Black_2880_2880.jpg`
      : `https://assets.nbatopshot.com/media/${l.id}?width=256`;

    tsDeals.push({
      flowId: String(l.id),
      momentId: String(l.id),
      editionKey,
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
      wapUsd: fmvRow.wapUsd,
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
      updatedAt: new Date().toISOString(),
      packListingId: fmvRow.packListingId,
      packName: fmvRow.packName,
      packEv: null,
      packEvRatio: null,
      buyUrl: l.set?.flowId && l.play?.flowID ? `https://nbatopshot.com/marketplace/editions/${l.set.flowId}/${l.play.flowID}${parallelId > 0 ? `/${parallelId}` : ''}` : `https://nbatopshot.com/moment/${l.id}`,
      listingResourceID: l.listingOrderID ?? l.storefrontListingID ?? null,
      listingOrderID: l.listingOrderID ?? null,
      storefrontAddress: l.sellerAddress ?? null,
      source: "topshot",
      paymentToken: "DUC",
      offerAmount: null,
      offerFmvPct: null,
    });
  }

  // 6. Enrich Flowty listings (with badge lookup from badgeMap)
  //    FMV priority: LiveToken → Supabase (via TS overlap) → ask-price fallback
  const flowtyDeals: SniperDeal[] = [];
  let flowtyLivetokenHits = 0, flowtySupabaseHits = 0, flowtyAskFallbacks = 0;
  for (const item of flowtyListings) {
    const askPrice = item.price;
    if (askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tier = item.tier ?? "COMMON";
    if (rarity !== "all" && tier.toLowerCase() !== rarity.toLowerCase()) continue;

    const teamAbbrev = TEAM_ABBREVS[item.teamName] ?? item.teamName;
    if (team !== "all" && teamAbbrev !== team && item.teamName !== team) continue;

    const serial = item.serial;
    const circ = item.circulationCount;
    const jerseyNumber = jerseyMap.get(item.playerName.toLowerCase().trim()) ?? null;
    const { mult: serialMult, signal: serialSignal, isSpecial: isSpecialSerial } =
      serialMultiplier(serial, circ > 0 ? circ : 99999, jerseyNumber);
    const isJersey = jerseyNumber !== null && serial === jerseyNumber;
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey" && !isJersey) continue;

    // FMV resolution: LiveToken → Supabase → ask-price fallback
    let baseFmv: number;
    let confidence: string;
    let confidenceSource: string;
    let editionKey = "";
    let fmvRow: FmvRow | null = null;

    if (item.livetokenFmv && item.livetokenFmv > 0) {
      // LiveToken FMV available
      baseFmv = item.livetokenFmv;
      confidence = "medium";
      confidenceSource = "livetoken";
      flowtyLivetokenHits++;
    } else {
      // Try Supabase FMV via TS listing overlap
      const overlappedKey = flowIdToEditionKey.get(item.momentId);
      if (overlappedKey) {
        fmvRow = fmvMap.get(overlappedKey) ?? null;
      }

      if (fmvRow && fmvRow.fmv > 0) {
        baseFmv = fmvRow.fmv;
        editionKey = fmvRow.editionKey;
        confidence = fmvRow.confidence;
        confidenceSource = "supabase";
        flowtySupabaseHits++;
      } else {
        // Ask-price fallback — show as speculative deal
        baseFmv = askPrice;
        confidence = "low";
        confidenceSource = "ask_fallback";
        flowtyAskFallbacks++;
      }
    }

    const adjustedFmv = baseFmv * serialMult;
    const discount = askPrice >= adjustedFmv
      ? 0
      : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;

    // For ask-price fallback deals (discount=0), only include if minDiscount is 0
    if (confidenceSource === "ask_fallback" && minDiscount > 0) continue;
    if (discount < minDiscount) continue;

    // Badge lookup by normalized player name
    const playerKey = item.playerName.toLowerCase().trim();
    const playerBadges = badgeMap.get(playerKey) ?? [];
    const badgeSlugs = playerBadges
      .map(b => {
        if (KNOWN_BADGES.has(b)) return b;
        const displayMatch = Object.keys(BADGE_LABELS).find(
          k => BADGE_LABELS[k].toLowerCase() === b.toLowerCase()
        );
        return displayMatch ?? null;
      })
      .filter((s): s is string => s !== null);
    const hasBadge = badgeSlugs.length > 0;

    if (badgeOnly && !hasBadge) continue;

    flowtyDeals.push({
      flowId: item.momentId,
      momentId: item.momentId,
      editionKey,
      playerName: item.playerName,
      teamName: teamAbbrev,
      setName: item.setName,
      seriesName: SERIES_NAMES[item.seriesNumber] ?? "",
      tier,
      parallel: item.subeditionId > 0 ? `Parallel #${item.subeditionId}` : "Base",
      parallelId: item.subeditionId,
      serial,
      circulationCount: circ,
      askPrice,
      baseFmv,
      adjustedFmv,
      wapUsd: fmvRow?.wapUsd ?? null,
      daysSinceSale: fmvRow?.daysSinceSale ?? null,
      salesCount30d: fmvRow?.salesCount30d ?? null,
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
      thumbnailUrl: `https://assets.nbatopshot.com/media/${item.momentId}?width=512`,
      isLocked: item.isLocked,
      updatedAt: item.blockTimestamp ? new Date(item.blockTimestamp).toISOString() : new Date().toISOString(),
      packListingId: fmvRow?.packListingId ?? null,
      packName: fmvRow?.packName ?? null,
      packEv: null,
      packEvRatio: null,
      buyUrl: `https://www.flowty.io/listing/${item.listingResourceID}`,
      listingResourceID: item.listingResourceID,
      listingOrderID: null,
      storefrontAddress: item.storefrontAddress,
      source: "flowty",
      paymentToken: item.paymentToken,
      offerAmount: null,
      offerFmvPct: null,
    });
  }

  console.log(`[sniper-feed] Flowty FMV sources: livetoken=${flowtyLivetokenHits} supabase=${flowtySupabaseHits} ask_fallback=${flowtyAskFallbacks}`);

  console.log(`[sniper-feed] built ts=${tsDeals.length} flowty=${flowtyDeals.length}`);

  // 7. Merge — Flowty wins on dedup by flowId, exclude retired moments
  const seen = new Set<string>();
  const allDeals: SniperDeal[] = [];
  for (const d of [...flowtyDeals, ...tsDeals]) {
    if (!seen.has(d.flowId) && !retiredIds.has(d.flowId)) {
      seen.add(d.flowId);
      allDeals.push(d);
    }
  }

  // 8b. Offer enrichment
  for (const d of allDeals) {
    const offer = offerMap.get(d.flowId);
    if (offer && offer.amount > 0) {
      d.offerAmount = offer.amount;
      d.offerFmvPct = d.adjustedFmv > 0 ? Math.round((offer.amount / d.adjustedFmv) * 1000) / 10 : null;
    }
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

  // 9. Sort
  const sorted = allDeals.sort((a, b) => {
    if (sortBy === "price_asc") return a.askPrice - b.askPrice;
    if (sortBy === "price_desc") return b.askPrice - a.askPrice;
    if (sortBy === "fmv_desc") return b.adjustedFmv - a.adjustedFmv;
    if (sortBy === "serial_asc") return a.serial - b.serial;
    if (sortBy === "listed_desc") return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
    return b.discount - a.discount;
  });

  const badgedCount = sorted.filter(d => d.hasBadge).length;
  console.log(
    `[sniper-feed] DONE ts=${tsDeals.length} flowty=${flowtyDeals.length} total=${sorted.length} ` +
    `badged=${badgedCount} fmv_hits=${fmvMap.size} badge_players=${badgeMap.size}`
  );

  // ── CACHE FALLBACK: if live feeds returned 0, read from Supabase cached_listings ──
  if (sorted.length === 0) {
    try {
      const { data: cachedRows } = await supabase
        .from("cached_listings")
        .select("*")
        .gt("discount", 0)
        .order("discount", { ascending: false })
        .limit(200);

      if (cachedRows && cachedRows.length > 0) {
        // Filter out retired moments from cached deals
        const liveCachedRows = cachedRows.filter((r: any) => !retiredIds.has(String(r.flow_id)));
        console.log("[sniper-feed] Live feeds empty, serving " + liveCachedRows.length + " cached deals (filtered " + (cachedRows.length - liveCachedRows.length) + " retired)");
        const cachedDeals = liveCachedRows.map(function (r: any) {
          return {
            flowId: r.flow_id || "",
            momentId: r.moment_id || "",
            editionKey: "",
            playerName: r.player_name || "",
            teamName: r.team_name || "",
            setName: r.set_name || "",
            seriesName: r.series_name || "",
            tier: r.tier || "COMMON",
            parallel: "Base",
            parallelId: 0,
            serial: r.serial_number || 0,
            circulationCount: r.circulation_count || 0,
            askPrice: Number(r.ask_price) || 0,
            baseFmv: Number(r.fmv) || 0,
            adjustedFmv: Number(r.adjusted_fmv) || Number(r.fmv) || 0,
            discount: Number(r.discount) || 0,
            confidence: r.confidence || "HIGH",
            hasBadge: false,
            badgeSlugs: r.badge_slugs || [],
            badgeLabels: [],
            badgePremiumPct: 0,
            serialMult: 1,
            isSpecialSerial: false,
            isJersey: false,
            serialSignal: null,
            thumbnailUrl: r.thumbnail_url || null,
            isLocked: r.is_locked || false,
            updatedAt: r.listed_at || r.cached_at || null,
            packListingId: null,
            packName: null,
            packEv: null,
            packEvRatio: null,
            buyUrl: r.buy_url || "",
            listingResourceID: r.listing_resource_id || null,
            listingOrderID: r.listing_order_id || null,
            storefrontAddress: r.storefront_address || null,
            source: (r.source || "flowty"),
            paymentToken: (r.payment_token || "DUC") as "DUC" | "FUT" | "FLOW" | "USDC_E",
            offerAmount: null as number | null,
            offerFmvPct: null as number | null,
          };
        });
        return {
          count: cachedDeals.length,
          tsCount: 0,
          flowtyCount: cachedDeals.length,
          lastRefreshed: new Date().toISOString(),
          deals: cachedDeals.map(d => {
            const offer = offerMap.get(d.flowId);
            if (offer && offer.amount > 0) {
              (d as unknown as SniperDeal).offerAmount = offer.amount;
              (d as unknown as SniperDeal).offerFmvPct = d.adjustedFmv > 0 ? Math.round((offer.amount / d.adjustedFmv) * 1000) / 10 : null;
            }
            return d;
          }),
          cached: true,
        };
      }
    } catch (cacheErr) {
      console.error("[sniper-feed] Cache fallback error: " + cacheErr);
    }
  }

  return {
    count: sorted.length,
    tsCount,
    flowtyCount: flowtyListings.length,
    lastRefreshed: new Date().toISOString(),
    deals: sorted,
  };
}