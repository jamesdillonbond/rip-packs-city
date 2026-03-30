// app/api/sniper-feed/route.ts
import { NextResponse } from "next/server";
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

// Badge premiums removed from FMV calculation per model philosophy:
// badge premium is already priced into market — applying it double-counts.
// Kept here only for display labels.
const BADGE_LABELS: Record<string, string> = {
  rookie_year: "Rookie Year", rookie_mint: "Rookie Mint", rookie_premiere: "Rookie Premiere",
  top_shot_debut: "TS Debut", three_star_rookie: "3★ Rookie", mvp: "MVP",
  championship_year: "Champ Year", rookie_of_the_year: "ROTY", fresh: "Fresh", autograph: "Auto",
  "Rookie Year": "Rookie Year", "Rookie Mint": "Rookie Mint", "Rookie Premiere": "Rookie Premiere",
  "Top Shot Debut": "TS Debut", "Three-Star Rookie": "3★ Rookie", "MVP Year": "MVP",
  "Championship Year": "Champ Year", "Rookie of the Year": "ROTY", "Fresh": "Fresh",
};

// Keep for badge detection only (not FMV multiplication)
const KNOWN_BADGES = new Set([
  "rookie_year", "rookie_mint", "rookie_premiere", "top_shot_debut",
  "three_star_rookie", "mvp", "championship_year", "rookie_of_the_year", "fresh", "autograph",
  "Rookie Year", "Rookie Mint", "Rookie Premiere", "Top Shot Debut",
  "Three-Star Rookie", "MVP Year", "Championship Year", "Rookie of the Year", "Fresh",
]);

const NBA_TEAMS: Record<string, string> = {
  "1610612737": "ATL", "1610612738": "BOS", "1610612739": "CLE", "1610612740": "NOP",
  "1610612741": "CHI", "1610612742": "DAL", "1610612743": "DEN", "1610612744": "GSW",
  "1610612745": "HOU", "1610612746": "LAC", "1610612747": "LAL", "1610612748": "MIA",
  "1610612749": "MIL", "1610612750": "MIN", "1610612751": "BKN", "1610612752": "NYK",
  "1610612753": "ORL", "1610612754": "IND", "1610612755": "PHI", "1610612756": "PHX",
  "1610612757": "POR", "1610612758": "SAC", "1610612759": "SAS", "1610612760": "OKC",
  "1610612761": "TOR", "1610612762": "UTA", "1610612763": "MEM", "1610612764": "WAS",
  "1610612765": "DET", "1610612766": "CHA",
  "1611661313": "ATL", "1611661314": "CHI", "1611661315": "CON", "1611661316": "IND",
  "1611661317": "NYL", "1611661318": "MIN", "1611661319": "PHX", "1611661320": "SEA",
  "1611661321": "WAS", "1611661322": "LVA", "1611661323": "DAL", "1611661324": "LA",
  "1611661325": "GS",
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
  0: "Beta", 1: "S1", 2: "S2", 3: "S3",
  4: "S4", 5: "S5", 6: "S6", 7: "S7", 8: "S8",
};

const PARALLEL_NAMES: Record<number, string> = {
  0: "Base", 1: "Holo MMXX", 2: "Throwbacks", 3: "Camo", 4: "Metaverse",
  5: "Cosmic", 6: "Ember", 7: "Infinite", 8: "Sapphire", 9: "Ruby",
  10: "Gold", 11: "Super Rare", 12: "Platinum Ice", 13: "Black Ice",
  14: "Bronze", 15: "Silver", 16: "Metallic Gold", 17: "Legendary", 18: "Unique",
  19: "Unique", 20: "Unique",
};

// Serial premium — only applied for truly special serials per model philosophy.
// #1, jersey match, last serial only. Everything else = 1.0 (no adjustment).
function serialPremium(serial: number, circ: number, jerseyNumber: number | null): number {
  if (serial === 1) return 8.0;
  if (jerseyNumber !== null && serial === jerseyNumber) return 2.5;
  if (serial === circ) return 1.3;
  return 1.0; // no premium for non-special serials
}

function buildThumbnailUrl(assetPathPrefix: string | undefined): string | null {
  if (assetPathPrefix) return `${assetPathPrefix}Hero_Black_2880_2880.jpg`;
  return null;
}

function formatParallel(parallelId: number): string {
  return PARALLEL_NAMES[parallelId] ?? `Parallel #${parallelId}`;
}

function formatSeries(seriesNumber: number | undefined): string {
  if (seriesNumber == null) return "";
  return SERIES_NAMES[seriesNumber] ?? `Series ${seriesNumber}`;
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
  livetokenFmv: number | null;   // LiveToken FMV signal from Flowty (for display + persistence)
  discount: number;
  confidence: string;
  hasBadge: boolean;
  badgeSlugs: string[];
  badgeLabels: string[];
  badgePremiumPct: number;       // kept for display, no longer used in FMV calculation
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
  storefrontAddress: string | null;
  source: "topshot" | "flowty";
}

// ─── TOP SHOT FEED ────────────────────────────────────────────────────────────

const SEARCH_TX_QUERY = `
  query SearchMarketplaceTransactions($input: SearchMarketplaceTransactionsInput!) {
    searchMarketplaceTransactions(input: $input) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            ... on MarketplaceTransactions {
              size
              data {
                ... on MarketplaceTransaction {
                  id price updatedAt
                  moment {
                    id flowId flowSerialNumber tier parallelID assetPathPrefix isLocked
                    set { id flowName flowSeriesNumber }
                    setPlay { ID flowRetired circulations { circulationCount forSaleByCollectors } }
                    parallelSetPlay { setID playID parallelID }
                    play { id stats { playerName jerseyNumber teamAtMomentNbaId } tags { id title } }
                    marketplaceID marketplaceListingID
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface RawTag { id: string; title: string; }
interface RawTransaction {
  id: string; price: string | number; updatedAt?: string;
  moment?: {
    id: string; flowId: string; flowSerialNumber: string; tier?: string;
    parallelID?: number; assetPathPrefix?: string; isLocked?: boolean;
    set?: { id: string; flowName?: string; flowSeriesNumber?: number };
    setPlay?: { ID?: string; flowRetired?: boolean; circulations?: { circulationCount: number } };
    parallelSetPlay?: { setID?: string; playID?: string; parallelID?: number };
    play?: { id: string; stats: { playerName: string; jerseyNumber?: string; teamAtMomentNbaId?: string }; tags?: RawTag[] };
    marketplaceID?: string;
    marketplaceListingID?: string;
  };
}

function parsePrice(p: string | number): number {
  return typeof p === "string" ? parseFloat(p) : (p ?? 0);
}

async function fetchTSPage(cursor: string, sortBy: string): Promise<{ txns: RawTransaction[]; nextCursor: string | null }> {
  const res = await fetch(TOPSHOT_GQL, {
    method: "POST", headers: GQL_HEADERS,
    body: JSON.stringify({
      operationName: "SearchMarketplaceTransactions",
      query: SEARCH_TX_QUERY,
      variables: { input: { sortBy, filters: {}, searchInput: { pagination: { cursor, direction: "RIGHT", limit: 100 } } } },
    }),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
  const summary = json?.data?.searchMarketplaceTransactions?.data?.searchSummary;
  return { txns: (summary?.data?.data ?? []) as RawTransaction[], nextCursor: summary?.pagination?.rightCursor ?? null };
}

async function fetchTopShotPool(): Promise<RawTransaction[]> {
  const seen = new Set<string>(); const all: RawTransaction[] = [];
  function add(txns: RawTransaction[]) {
    for (const tx of txns) { const k = tx.moment?.id ?? tx.id; if (!seen.has(k)) { seen.add(k); all.push(tx); } }
  }
  const { txns: p1, nextCursor: c1 } = await fetchTSPage("", "UPDATED_AT_DESC");
  add(p1);
  if (c1) { try { const { txns: p2 } = await fetchTSPage(c1, "UPDATED_AT_DESC"); add(p2); } catch (e) { console.warn("[sniper] TS page 2:", e); } }
  try { const { txns: cheap } = await fetchTSPage("", "PRICE_ASC"); add(cheap); } catch (e) { console.warn("[sniper] TS PRICE_ASC:", e); }
  return all;
}

function computeEditionFloors(txns: RawTransaction[]): Map<string, { floor: number; count: number }> {
  const byEdition = new Map<string, number[]>();
  for (const tx of txns) {
    const psp = tx.moment?.parallelSetPlay;
    if (!psp?.setID || !psp?.playID) continue;
    const key = `${psp.setID}:${psp.playID}`;
    const price = parsePrice(tx.price);
    if (!price || price <= 0) continue;
    const arr = byEdition.get(key) ?? []; arr.push(price); byEdition.set(key, arr);
  }
  const floors = new Map<string, { floor: number; count: number }>();
  for (const [key, prices] of byEdition.entries()) {
    prices.sort((a, b) => a - b);
    floors.set(key, { floor: prices[0], count: prices.length });
  }
  return floors;
}

async function fetchSupabaseFmv(
  supabase: SupabaseClient,
  externalIds: string[]
): Promise<Map<string, { fmv: number; confidence: string; editionUuid: string }>> {
  if (!externalIds.length) return new Map();
  const { data: editionRows } = await supabase
    .from("editions")
    .select("id, external_id")
    .in("external_id", externalIds);
  if (!editionRows?.length) return new Map();

  const extToSup = new Map<string, string>();
  const supToExt = new Map<string, string>();
  for (const row of editionRows as { id: string; external_id: string }[]) {
    extToSup.set(row.external_id, row.id);
    supToExt.set(row.id, row.external_id);
  }

  const { data: fmvRows } = await supabase
    .from("fmv_snapshots")
    .select("edition_id, fmv_usd, confidence, computed_at")
    .in("edition_id", Array.from(extToSup.values()))
    .order("computed_at", { ascending: false });

  if (!fmvRows?.length) return new Map();
  const seen = new Set<string>();
  const map = new Map<string, { fmv: number; confidence: string; editionUuid: string }>();
  for (const row of fmvRows as { edition_id: string; fmv_usd: number; confidence: string }[]) {
    if (seen.has(row.edition_id)) continue;
    seen.add(row.edition_id);
    const externalId = supToExt.get(row.edition_id);
    if (!externalId) continue;
    map.set(externalId, {
      fmv: row.fmv_usd,
      confidence: (row.confidence ?? "low").toLowerCase(),
      editionUuid: row.edition_id,
    });
  }
  return map;
}

function extractBadgeSlugs(tx: RawTransaction): string[] {
  return (tx.moment?.play?.tags ?? [])
    .map(t => KNOWN_BADGES.has(t.id) ? t.id : KNOWN_BADGES.has(t.title) ? t.title : null)
    .filter((s): s is string => s !== null);
}

function buildTSDeal(
  tx: RawTransaction,
  editionFloors: Map<string, { floor: number; count: number }>,
  supabaseFmv: Map<string, { fmv: number; confidence: string; editionUuid: string }>
): SniperDeal | null {
  if (!tx.moment) return null;
  const askPrice = parsePrice(tx.price); if (!askPrice || askPrice <= 0) return null;
  const m = tx.moment; const psp = m.parallelSetPlay;
  const editionKey = psp?.setID && psp?.playID ? `${psp.setID}:${psp.playID}` : null;
  if (!editionKey) return null;
  const floorData = editionFloors.get(editionKey); if (!floorData) return null;
  const sbRow = supabaseFmv.get(editionKey);
  let baseFmv: number; let confidence: string;
  if (sbRow) {
    baseFmv = floorData.count >= 2 ? Math.min(sbRow.fmv, floorData.floor) : sbRow.fmv;
    confidence = sbRow.confidence;
  } else if (floorData.count >= 2) {
    baseFmv = floorData.floor; confidence = floorData.count >= 5 ? "medium" : "low";
  } else { return null; }

  const circ = m.setPlay?.circulations?.circulationCount ?? 1000;
  const serial = parseInt(m.flowSerialNumber ?? "0", 10); if (!serial) return null;
  const jerseyNumber = m.play?.stats?.jerseyNumber ? parseInt(m.play.stats.jerseyNumber, 10) : null;
  const badgeSlugs = extractBadgeSlugs(tx);
  const hasBadge = badgeSlugs.length > 0;

  // Serial premium — special serials only, no badge multiplier
  const serialMult = serialPremium(serial, circ, jerseyNumber);
  const isSpecialSerial = serialMult > 1.0;
  const jerseyMatch = jerseyNumber !== null && serial === jerseyNumber;
  const isJersey = jerseyMatch;

  // FMV = base × serial premium only (badge already priced into market)
  const adjustedFmv = baseFmv * serialMult;
  const discount = ((adjustedFmv - askPrice) / adjustedFmv) * 100;
  const parallelId = psp?.parallelID ?? m.parallelID ?? 0;
  const teamId = m.play?.stats?.teamAtMomentNbaId ?? "";
  const teamName = NBA_TEAMS[teamId] ?? teamId;
  const tierRaw = (m.tier ?? "COMMON").replace("MOMENT_TIER_", "");

  return {
    flowId: m.flowId, momentId: m.id, editionKey,
    playerName: m.play?.stats?.playerName ?? "Unknown", teamName,
    setName: m.set?.flowName ?? "", seriesName: formatSeries(m.set?.flowSeriesNumber),
    tier: tierRaw, parallel: formatParallel(parallelId), parallelId, serial, circulationCount: circ,
    askPrice, baseFmv, adjustedFmv, livetokenFmv: null,
    discount: Math.round(discount * 10) / 10, confidence,
    hasBadge, badgeSlugs, badgeLabels: badgeSlugs.map(s => BADGE_LABELS[s] ?? s),
    badgePremiumPct: 0, // no longer used in FMV calc
    serialMult: Math.round(serialMult * 100) / 100,
    isSpecialSerial, isJersey,
    serialSignal: serial === 1 ? "Serial #1" : serial === circ ? "Last Mint" : jerseyMatch ? `Jersey #${serial}` : null,
    thumbnailUrl: buildThumbnailUrl(m.assetPathPrefix), isLocked: m.isLocked ?? false,
    updatedAt: tx.updatedAt ?? null, packListingId: null, packName: null, packEv: null, packEvRatio: null,
    buyUrl: `https://nbatopshot.com/moment/${m.flowId}`,
    listingResourceID: m.marketplaceListingID ?? null,
    storefrontAddress: m.marketplaceID ?? null,
    source: "topshot",
  };
}

// ─── FLOWTY FEED ─────────────────────────────────────────────────────────────

interface FlowtyNft {
  id: string;
  card: { title: string; num: string | number; max: string | number; images: { url: string }[] };
  nftView: {
    serial: string; externalURL: { url: string };
    traits: { traits: { name: string; value: string }[] };
    editions?: { infoList: { max: number; number: number }[] };
  };
  orders: {
    salePrice: number; blockTimestamp: number; listingResourceID: string;
    state: string; paymentTokenName: string; nftID: string; storefrontAddress?: string;
  }[];
  valuations: { blended?: { usdValue: number }; livetoken?: { usdValue: number } };
}

function getFlowtyTrait(traits: { name: string; value: string }[], name: string): string | null {
  return traits.find(t => t.name === name)?.value ?? null;
}

async function fetchFlowtyPage(from: number): Promise<FlowtyNft[]> {
  const res = await fetch(FLOWTY_ENDPOINT, {
    method: "POST", headers: FLOWTY_HEADERS,
    body: JSON.stringify({
      address: null, addresses: [],
      collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
      from, includeAllListings: true, limit: 24, onlyUnlisted: false,
      orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
      sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
    }),
  });
  if (!res.ok) throw new Error(`Flowty HTTP ${res.status}`);
  const data = await res.json();
  return (data.nfts ?? []) as FlowtyNft[];
}

function buildFlowtyDeal(nft: FlowtyNft, badgeMap: Map<string, string[]>): SniperDeal | null {
  const order = nft.orders?.find(o => o.state === "LISTED");
  if (!order) return null;
  const askPrice = order.salePrice; if (!askPrice || askPrice <= 0) return null;
  const traits = nft.nftView?.traits?.traits ?? [];
  const playerName = nft.card?.title ?? getFlowtyTrait(traits, "FullName") ?? "Unknown";
  const teamFull = getFlowtyTrait(traits, "TeamAtMoment") ?? "";
  const teamName = TEAM_ABBREVS[teamFull] ?? teamFull;
  const setName = getFlowtyTrait(traits, "SetName") ?? "";
  const seriesStr = getFlowtyTrait(traits, "SeriesNumber");
  const seriesNumber = seriesStr != null ? parseInt(seriesStr, 10) : -1;
  const seriesName = seriesNumber >= 0 ? (SERIES_NAMES[seriesNumber] ?? `Series ${seriesNumber}`) : "";
  const tierRaw = getFlowtyTrait(traits, "Tier") ?? "Common";
  const tier = tierRaw.toUpperCase();
  const subeditionIdStr = getFlowtyTrait(traits, "SubeditionID");
  const parallelId = subeditionIdStr != null ? parseInt(subeditionIdStr, 10) : 0;
  const parallel = PARALLEL_NAMES[parallelId] ?? `Parallel #${parallelId}`;
  const isLockedStr = getFlowtyTrait(traits, "Locked");
  const isLocked = isLockedStr === "true";
  const serialStr = nft.nftView?.serial ?? String(nft.card?.num ?? "0");
  const serial = parseInt(serialStr, 10); if (!serial) return null;
  const circRaw = nft.nftView?.editions?.infoList?.[0]?.max ?? nft.card?.max;
  const circulationCount = typeof circRaw === "string" ? parseInt(circRaw, 10) : (circRaw ?? 1000);

  // LiveToken FMV — use as baseFmv, also store separately for persistence
  const livetokenFmv = nft.valuations?.livetoken?.usdValue ?? null;
  const blendedFmv = nft.valuations?.blended?.usdValue ?? 0;
  const baseFmv = blendedFmv > 0 ? blendedFmv : (livetokenFmv ?? 0);
  if (baseFmv <= 0) return null;

  const badgeKey = `${playerName}:${seriesNumber}`;
  const badgeSlugs = badgeMap.get(badgeKey) ?? [];
  const hasBadge = badgeSlugs.length > 0;

  // Serial premium — special serials only, no badge multiplier
  // jerseyNumber not available from Flowty traits directly
  const serialMult = serialPremium(serial, circulationCount, null);
  const isSpecialSerial = serialMult > 1.0;
  const isJersey = false; // Flowty doesn't provide jerseyNumber

  // FMV = LiveToken base × serial premium only
  const adjustedFmv = baseFmv * serialMult;
  const discount = ((adjustedFmv - askPrice) / adjustedFmv) * 100;

  const flowtyThumb = nft.card?.images?.[0]?.url ?? null;
  const thumbnailUrl = flowtyThumb ? flowtyThumb.replace("?width=256", "?width=512") : null;
  const updatedAt = new Date(order.blockTimestamp).toISOString();
  const flowId = order.nftID ?? nft.id;

  return {
    flowId, momentId: nft.id, editionKey: "",  // resolved below in persistLivetokenFmv
    playerName, teamName, setName, seriesName, tier, parallel, parallelId,
    serial, circulationCount, askPrice, baseFmv, adjustedFmv, livetokenFmv,
    discount: Math.round(discount * 10) / 10, confidence: "high",
    hasBadge, badgeSlugs, badgeLabels: badgeSlugs.map(s => BADGE_LABELS[s] ?? s),
    badgePremiumPct: 0,
    serialMult: Math.round(serialMult * 100) / 100,
    isSpecialSerial, isJersey,
    serialSignal: serial === 1 ? "Serial #1" : serial === circulationCount ? "Last Mint" : isSpecialSerial ? `Low #${serial}` : null,
    thumbnailUrl, isLocked, updatedAt,
    packListingId: null, packName: null, packEv: null, packEvRatio: null,
    buyUrl: `https://www.flowty.io/listing/${order.listingResourceID}`,
    listingResourceID: order.listingResourceID ?? null,
    storefrontAddress: order.storefrontAddress ?? null,
    source: "flowty",
  };
}

// ─── LIVETOKEN FMV PERSISTENCE ───────────────────────────────────────────────
//
// Fire-and-forget: after the sniper response is built, persist LiveToken FMV
// values from Flowty deals back to fmv_snapshots. This enriches the FMV model
// with LiveToken's signal for free on every sniper page load.
//
// Only writes flowty_ask and cross_market_ask — does not overwrite fmv_usd
// (our sales-based model). Uses delete-then-insert pattern for partitioned table.

async function persistLivetokenFmv(
  supabase: SupabaseClient,
  flowtyDeals: SniperDeal[],
  tsDeals: SniperDeal[],
  supabaseFmv: Map<string, { fmv: number; confidence: string; editionUuid: string }>
): Promise<void> {
  try {
    // Build TS ask floor map by flowId for cross-market ask calculation
    const tsAskByFlowId = new Map<string, number>();
    for (const d of tsDeals) {
      const existing = tsAskByFlowId.get(d.flowId);
      if (!existing || d.askPrice < existing) tsAskByFlowId.set(d.flowId, d.askPrice);
    }

    // Build editionKey map from TS deals by flowId.
    // Flowty deals share the same flowId as TS deals for the same NFT,
    // so we can resolve editionKey → Supabase UUID via the existing supabaseFmv map.
    const editionKeyByFlowId = new Map<string, string>();
    for (const d of tsDeals) {
      if (d.editionKey) editionKeyByFlowId.set(d.flowId, d.editionKey);
    }

    // Filter Flowty deals that have LiveToken FMV + a resolvable Supabase edition UUID
    const enrichable: Array<{
      deal: SniperDeal;
      editionUuid: string;
    }> = [];

    for (const deal of flowtyDeals) {
      if (!deal.livetokenFmv || deal.livetokenFmv <= 0) continue;
      const editionKey = editionKeyByFlowId.get(deal.flowId);
      if (!editionKey) continue;
      const sbRow = supabaseFmv.get(editionKey);
      if (!sbRow?.editionUuid) continue;
      enrichable.push({ deal, editionUuid: sbRow.editionUuid });
    }

    if (!enrichable.length) {
      console.log("[sniper] LiveToken persistence: 0 Flowty deals matched TS counterparts");
      return;
    }

    // Resolve collection_id for matched editions
    const editionUuids = [...new Set(enrichable.map(e => e.editionUuid))];
    const { data: editionRows } = await supabase
      .from("editions")
      .select("id, collection_id")
      .in("id", editionUuids);

    const collectionByEdition = new Map<string, string>();
    for (const row of (editionRows ?? []) as { id: string; collection_id: string }[]) {
      collectionByEdition.set(row.id, row.collection_id);
    }

    // Fetch latest snapshots for these editions
    const { data: existing } = await supabase
      .from("fmv_snapshots")
      .select("*")
      .in("edition_id", editionUuids)
      .order("computed_at", { ascending: false });

    const latestByEdition = new Map<string, Record<string, unknown>>();
    for (const row of (existing ?? []) as Record<string, unknown>[]) {
      const eid = row.edition_id as string;
      if (!latestByEdition.has(eid)) latestByEdition.set(eid, row);
    }

    // Delete old snapshots
    await supabase.from("fmv_snapshots").delete().in("edition_id", editionUuids);

    // Build insert rows — one per unique edition
    const seen = new Set<string>();
    const insertRows = [];

    for (const { deal, editionUuid } of enrichable) {
      if (seen.has(editionUuid)) continue;
      seen.add(editionUuid);

      const collectionId = collectionByEdition.get(editionUuid);
      if (!collectionId) continue;

      const base = latestByEdition.get(editionUuid) ?? {};
      const tsAsk = tsAskByFlowId.get(deal.flowId) ?? null;
      const crossMarketAsk = tsAsk !== null
        ? Math.min(deal.askPrice, tsAsk)
        : deal.askPrice;

      insertRows.push({
        ...base,
        id: undefined,
        edition_id: editionUuid,
        collection_id: collectionId,
        flowty_ask: deal.askPrice,
        top_shot_ask: tsAsk ?? (base.top_shot_ask as number | null) ?? null,
        cross_market_ask: crossMarketAsk,
        algo_version: "1.2.1",
      });
    }

    if (!insertRows.length) return;

    const CHUNK = 50;
    for (let i = 0; i < insertRows.length; i += CHUNK) {
      await supabase.from("fmv_snapshots").insert(insertRows.slice(i, i + CHUNK));
    }

    console.log(`[sniper] LiveToken FMV persisted for ${insertRows.length} editions`);
  } catch (err) {
    console.warn("[sniper] LiveToken persistence failed (non-fatal):", err);
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minDiscount = parseFloat(url.searchParams.get("minDiscount") ?? "0");
  const rarity = url.searchParams.get("rarity") ?? "all";
  const badgeOnly = url.searchParams.get("badgeOnly") === "true";
  const serialFilter = url.searchParams.get("serial") ?? "all";
  const maxPrice = parseFloat(url.searchParams.get("maxPrice") ?? "0");

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // Fetch Top Shot + Flowty in parallel
  const [tsResult, flowtyResult] = await Promise.allSettled([
    fetchTopShotPool(),
    Promise.all([fetchFlowtyPage(0), fetchFlowtyPage(24)]).then(([p0, p1]) => [...p0, ...p1]),
  ]);

  const tsTxns: RawTransaction[] = tsResult.status === "fulfilled" ? tsResult.value : [];
  const flowtyNfts: FlowtyNft[] = flowtyResult.status === "fulfilled" ? flowtyResult.value : [];

  if (tsResult.status === "rejected") console.error("[sniper] TS fetch failed:", tsResult.reason);
  if (flowtyResult.status === "rejected") console.warn("[sniper] Flowty fetch failed:", flowtyResult.reason);

  console.log(`[sniper] TS pool: ${tsTxns.length}, Flowty NFTs: ${flowtyNfts.length}`);

  // Filter TS txns by rarity
  const filteredTsTxns = rarity !== "all"
    ? tsTxns.filter(tx => (tx.moment?.tier ?? "").toUpperCase().includes(rarity.toUpperCase()))
    : tsTxns;

  // Build TS deals
  const editionFloors = computeEditionFloors(tsTxns);
  const editionKeys = Array.from(editionFloors.keys());
  const supabaseFmv = await fetchSupabaseFmv(supabase, editionKeys);
  console.log(`[sniper] Supabase FMV hits: ${supabaseFmv.size}/${editionKeys.length}`);

  const tsDeals: SniperDeal[] = filteredTsTxns
    .map(tx => buildTSDeal(tx, editionFloors, supabaseFmv))
    .filter((d): d is SniperDeal => d !== null);

  // Deduplicate Flowty NFTs
  const seenFlowty = new Set<string>(); const uniqueFlowtyNfts: FlowtyNft[] = [];
  for (const nft of flowtyNfts) { if (!seenFlowty.has(nft.id)) { seenFlowty.add(nft.id); uniqueFlowtyNfts.push(nft); } }

  // Badge lookup for Flowty
  const flowtyPairs: { playerName: string; seriesNumber: number }[] = [];
  for (const nft of uniqueFlowtyNfts) {
    const traits = nft.nftView?.traits?.traits ?? [];
    const playerName = nft.card?.title ?? "";
    const seriesStr = getFlowtyTrait(traits, "SeriesNumber");
    const seriesNumber = seriesStr != null ? parseInt(seriesStr, 10) : -1;
    if (playerName && seriesNumber >= 0) flowtyPairs.push({ playerName, seriesNumber });
  }

  const flowtyBadgeMap = new Map<string, string[]>();
  if (flowtyPairs.length > 0) {
    const playerNames = [...new Set(flowtyPairs.map(p => p.playerName))];
    const { data: badgeRows } = await supabase
      .from("badge_editions")
      .select("player_name, badge_type, series_number")
      .in("player_name", playerNames);
    if (badgeRows?.length) {
      for (const row of badgeRows as { player_name: string; badge_type: string; series_number: number }[]) {
        const pair = flowtyPairs.find(p =>
          p.playerName.toLowerCase() === row.player_name.toLowerCase() &&
          p.seriesNumber === row.series_number
        );
        if (!pair) continue;
        const key = `${pair.playerName}:${pair.seriesNumber}`;
        const arr = flowtyBadgeMap.get(key) ?? [];
        if (!arr.includes(row.badge_type)) arr.push(row.badge_type);
        flowtyBadgeMap.set(key, arr);
      }
    }
  }

  // Filter Flowty by rarity
  const filteredFlowtyNfts = rarity !== "all"
    ? uniqueFlowtyNfts.filter(nft => {
        const traits = nft.nftView?.traits?.traits ?? [];
        const tier = getFlowtyTrait(traits, "Tier") ?? "";
        return tier.toLowerCase().includes(rarity.toLowerCase());
      })
    : uniqueFlowtyNfts;

  const flowtyDeals: SniperDeal[] = filteredFlowtyNfts
    .map(nft => buildFlowtyDeal(nft, flowtyBadgeMap))
    .filter((d): d is SniperDeal => d !== null);

  console.log(`[sniper] TS deals: ${tsDeals.length}, Flowty deals: ${flowtyDeals.length}`);

  // Merge — Flowty wins on conflict (has LiveToken FMV signal)
  const mergedMap = new Map<string, SniperDeal>();
  for (const deal of tsDeals) mergedMap.set(deal.flowId, deal);
  for (const deal of flowtyDeals) mergedMap.set(deal.flowId, deal);

  const allDeals = Array.from(mergedMap.values());

  // Fire-and-forget LiveToken FMV persistence — does not block response
  persistLivetokenFmv(supabase, flowtyDeals, tsDeals, supabaseFmv).catch(() => {});

  // Apply filters
  const filtered = allDeals.filter(m => {
    if (m.discount < minDiscount) return false;
    if (badgeOnly && !m.hasBadge) return false;
    if (maxPrice > 0 && m.askPrice > maxPrice) return false;
    if (serialFilter === "special" && !m.isSpecialSerial) return false;
    if (serialFilter === "jersey" && !m.isJersey) return false;
    return true;
  });

  // Sort by updatedAt desc
  const deals = filtered
    .sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 200);

  console.log(`[sniper] merged: ${allDeals.length}, filtered: ${filtered.length}, final: ${deals.length}`);
  return NextResponse.json({ count: deals.length, lastRefreshed: new Date().toISOString(), deals });
}