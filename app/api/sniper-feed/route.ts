import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawListing {
  id: string;
  flowRetailPrice?: { value: string };
  marketplacePrice?: number;
  setPlay: {
    setID: number;
    playID: number;
    parallelID?: number;
  };
  serialNumber: number;
  circulationCount: number;
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
  setSeriesNumber?: number;
  parallelSetPlay?: { setID: number; playID: number; parallelID?: number };
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
  storefrontAddress: string | null;
  source: "topshot" | "flowty";
  offerAmount: number | null;
  offerFmvPct: number | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TS_GQL = "https://public-api.nbatopshot.com/graphql";
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
};

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

const SEARCH_LISTINGS_QUERY = `
  {
    searchMomentListings(
      input: {
        filters: { byListings: { listingType: { value: FOR_SALE } } }
        searchInput: { pagination: { cursor: "", direction: RIGHT, count: 100 } }
      }
    ) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            ... on MomentListings {
              size
              data {
                ... on MomentListing {
                  id
                  flowRetailPrice { value }
                  setPlay {
                    setID
                    playID
                    parallelID
                  }
                  serialNumber
                  circulationCount
                  setName
                  momentTier
                  momentTitle
                  playerName
                  isLocked
                  storefrontListingID
                  sellerAddress
                }
              }
            }
          }
        }
      }
    }
  }
`;

function parseListingPrice(listing: RawListing): number {
  if (listing.flowRetailPrice?.value) {
    return parseFloat(listing.flowRetailPrice.value) / 100_000_000;
  }
  if (listing.marketplacePrice) return listing.marketplacePrice;
  return 0;
}

async function fetchTSPage(
  cursor: string,
  sortBy: string
): Promise<{ listings: RawListing[]; nextCursor: string | null }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(TS_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({ query: SEARCH_LISTINGS_QUERY }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`GQL ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
    const summary = json?.data?.searchMomentListings?.data?.searchSummary;
    const nextCursor = summary?.pagination?.rightCursor ?? null;
    const listings: RawListing[] = [];
    const dataField = summary?.data;
    if (Array.isArray(dataField)) {
      for (const block of dataField) {
        if (Array.isArray(block?.data)) listings.push(...block.data);
      }
    } else if (dataField?.data && Array.isArray(dataField.data)) {
      listings.push(...dataField.data);
    }
    console.log(`[sniper-feed] TS page sortBy=${sortBy} listings=${listings.length}`);
    return { listings, nextCursor };
  } catch (err) {
    console.error(`[sniper-feed] TS page FAILED sortBy=${sortBy}: ${err instanceof Error ? err.message : String(err)}`);
    return { listings: [], nextCursor: null };
  }
}

async function fetchTopShotPool(): Promise<{ listings: RawListing[]; tsCount: number }> {
  const seen = new Set<string>();
  const all: RawListing[] = [];
  function add(listings: RawListing[]) {
    for (const l of listings) {
      if (!seen.has(l.id)) { seen.add(l.id); all.push(l); }
    }
  }

  const [r1, r2] = await Promise.allSettled([
    fetchTSPage("", ""),
    fetchTSPage("", ""),
  ]);

  if (r1.status === "fulfilled") add(r1.value.listings);
  if (r2.status === "fulfilled") add(r2.value.listings);

  console.log(`[sniper-feed] TS pool: p1=${r1.status === "fulfilled" ? r1.value.listings.length : "FAIL"} p2=${r2.status === "fulfilled" ? r2.value.listings.length : "FAIL"} total=${all.length}`);
  return { listings: all, tsCount: all.length };
}

// ─── Flowty helpers ───────────────────────────────────────────────────────────

interface FlowtyOrder {
  listingResourceID: string;
  storefrontAddress: string;
  flowtyStorefrontAddress?: string;
  salePrice: number;
  blockTimestamp: number;
  state?: string;
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
    const timeout = setTimeout(() => controller.abort(), 6000);
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

// ─── Route handler ────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 25;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minDiscount = parseFloat(url.searchParams.get("minDiscount") ?? "0");
  const rarity = url.searchParams.get("rarity") ?? "all";
  const team = url.searchParams.get("team") ?? "all";
  const badgeOnly = url.searchParams.get("badgeOnly") === "true";
  const serialFilter = url.searchParams.get("serial") ?? "all";
  const maxPrice = parseFloat(url.searchParams.get("maxPrice") ?? "0");
  const sortBy = url.searchParams.get("sortBy") ?? "discount";

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Fetch TS listings + Flowty in parallel
  const [{ listings: tsListings, tsCount }, flowtyListings] = await Promise.all([
    fetchTopShotPool(),
    fetchAllFlowtyListings(),
  ]);

  console.log(`[sniper-feed] fetched ts=${tsListings.length} flowty=${flowtyListings.length}`);

  // 2. Build integer edition keys for Supabase FMV lookup (TS only)
  const tsEditionKeys = new Set<string>();
  for (const l of tsListings) {
    const sp = l.setPlay;
    if (sp?.setID && sp?.playID) {
      const parallelId = sp.parallelID ?? 0;
      const key = parallelId > 0 ? `${sp.setID}:${sp.playID}::${parallelId}` : `${sp.setID}:${sp.playID}`;
      tsEditionKeys.add(key);
      tsEditionKeys.add(`${sp.setID}:${sp.playID}`);
    }
  }

  // 3. Collect unique player names from Flowty for badge lookup
  const flowtyPlayerNames = Array.from(
    new Set(flowtyListings.map(l => l.playerName).filter(Boolean))
  );

  // 4. Fire all Supabase lookups in parallel
  const [fmvMap, badgeMap, offersRes] = await Promise.all([
    fetchFmvBatch(supabase, Array.from(tsEditionKeys)),
    fetchBadgesByPlayers(supabase, flowtyPlayerNames),
    fetch("https://rip-packs-city.vercel.app/api/flowty-offers")
      .then(r => r.ok ? r.json() : { offers: {} })
      .catch(() => ({ offers: {} })),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const offerMap = new Map<string, { amount: number; fmv: number | null }>(
    Object.entries((offersRes?.offers ?? {}) as Record<string, { amount: number; fmv: number | null }>)
  );
  console.log(`[sniper-feed] offerMap size=${offerMap.size}`);

  // 5. Enrich TS listings
  const tsDeals: SniperDeal[] = [];
  for (const l of tsListings) {
    const askPrice = parseListingPrice(l);
    if (!askPrice || askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tierRaw = (l.momentTier ?? "COMMON").replace("MOMENT_TIER_", "");
    if (rarity !== "all" && tierRaw.toUpperCase() !== rarity.toUpperCase()) continue;

    const sp = l.setPlay;
    if (!sp?.setID || !sp?.playID) continue;
    const parallelId = sp.parallelID ?? 0;
    const editionKeyParallel = parallelId > 0 ? `${sp.setID}:${sp.playID}::${parallelId}` : null;
    const editionKeyBase = `${sp.setID}:${sp.playID}`;
    const editionKey = editionKeyParallel ?? editionKeyBase;

    const serial = l.serialNumber ?? 0;
    if (!serial) continue;
    const circ = l.circulationCount ?? 1000;

    const { mult: serialMult, signal: serialSignal, isSpecial: isSpecialSerial } =
      serialMultiplier(serial, circ, null);

    const teamName = NBA_TEAMS[l.teamAtMomentNbaId ?? ""] ?? "";
    if (team !== "all" && teamName !== team) continue;

    const badgeSlugs = extractBadgeSlugs(l.tags);
    const hasBadge = badgeSlugs.length > 0;
    if (badgeOnly && !hasBadge) continue;
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey") continue;

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
      : null;

    tsDeals.push({
      flowId: String(l.id),
      momentId: String(l.id),
      editionKey,
      playerName: l.playerName ?? l.momentTitle ?? "Unknown",
      teamName,
      setName: l.setName ?? "",
      seriesName: l.setSeriesNumber != null ? (SERIES_NAMES[l.setSeriesNumber] ?? "") : "",
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
      isJersey: false,
      serialSignal,
      thumbnailUrl,
      isLocked: l.isLocked ?? false,
      updatedAt: new Date().toISOString(),
      packListingId: fmvRow.packListingId,
      packName: fmvRow.packName,
      packEv: null,
      packEvRatio: null,
      buyUrl: `https://nbatopshot.com/moment/${l.id}`,
      listingResourceID: l.storefrontListingID ?? null,
      storefrontAddress: l.sellerAddress ?? null,
      source: "topshot",
      offerAmount: null,
      offerFmvPct: null,
    });
  }

  // 6. Enrich Flowty listings (with badge lookup from badgeMap)
  const flowtyDeals: SniperDeal[] = [];
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
    const { mult: serialMult, signal: serialSignal, isSpecial: isSpecialSerial } =
      serialMultiplier(serial, circ > 0 ? circ : 99999, null);
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey") continue;

    if (!item.livetokenFmv || item.livetokenFmv <= 0) continue;

    const baseFmv = item.livetokenFmv;
    const adjustedFmv = baseFmv * serialMult;
    const discount = askPrice >= adjustedFmv
      ? 0
      : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;
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
      editionKey: "",
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
      wapUsd: null,
      daysSinceSale: null,
      salesCount30d: null,
      discount,
      confidence: "medium",
      confidenceSource: "livetoken",
      hasBadge,
      badgeSlugs,
      badgeLabels: badgeSlugs.map(s => BADGE_LABELS[s] ?? s),
      badgePremiumPct: 0,
      serialMult,
      isSpecialSerial,
      isJersey: false,
      serialSignal,
      thumbnailUrl: `https://assets.nbatopshot.com/media/${item.momentId}?width=512`,
      isLocked: item.isLocked,
      updatedAt: item.blockTimestamp ? new Date(item.blockTimestamp).toISOString() : new Date().toISOString(),
      packListingId: null,
      packName: null,
      packEv: null,
      packEvRatio: null,
      buyUrl: `https://www.flowty.io/listing/${item.listingResourceID}`,
      listingResourceID: item.listingResourceID,
      storefrontAddress: item.storefrontAddress,
      source: "flowty",
      offerAmount: null,
      offerFmvPct: null,
    });
  }

  console.log(`[sniper-feed] built ts=${tsDeals.length} flowty=${flowtyDeals.length}`);

  // 7. Merge — Flowty wins on dedup by flowId
  const seen = new Set<string>();
  const allDeals: SniperDeal[] = [];
  for (const d of [...flowtyDeals, ...tsDeals]) {
    if (!seen.has(d.flowId)) { seen.add(d.flowId); allDeals.push(d); }
  }

  // 8b. Offer enrichment
  for (const d of allDeals) {
    const offer = offerMap.get(d.flowId);
    if (offer && offer.amount > 0) {
      d.offerAmount = offer.amount;
      const fmvBase = offer.fmv ?? d.baseFmv;
      d.offerFmvPct = fmvBase > 0 ? Math.round((offer.amount / fmvBase) * 1000) / 10 : null;
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
        console.log("[sniper-feed] Live feeds empty, serving " + cachedRows.length + " cached deals");
        const cachedDeals = cachedRows.map(function (r) {
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
            source: (r.source || "flowty"),
            offerAmount: null as number | null,
            offerFmvPct: null as number | null,
          };
        });
        return NextResponse.json(
          {
            count: cachedDeals.length,
            tsCount: 0,
            flowtyCount: cachedDeals.length,
            lastRefreshed: new Date().toISOString(),
            deals: cachedDeals.map(d => {
              const offer = offerMap.get(d.flowId);
              if (offer && offer.amount > 0) {
                d.offerAmount = offer.amount;
                const fmvBase = (offer.fmv ?? d.baseFmv) || 0;
                d.offerFmvPct = fmvBase > 0 ? Math.round((offer.amount / fmvBase) * 1000) / 10 : null;
              }
              return d;
            }),
            cached: true,
          },
          { headers: { "Cache-Control": "public, max-age=0, s-maxage=25, stale-while-revalidate=60" } }
        );
      }
    } catch (cacheErr) {
      console.error("[sniper-feed] Cache fallback error: " + cacheErr);
    }
  }

  return NextResponse.json(
    {
      count: sorted.length,
      tsCount,
      flowtyCount: flowtyListings.length,
      lastRefreshed: new Date().toISOString(),
      deals: sorted,
    },
    {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=25, stale-while-revalidate=60" },
    }
  );
}