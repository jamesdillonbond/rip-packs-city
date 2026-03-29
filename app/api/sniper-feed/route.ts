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

const BADGE_PREMIUMS: Record<string, number> = {
  rookie_year: 0.45, rookie_mint: 0.35, rookie_premiere: 0.30,
  top_shot_debut: 0.25, three_star_rookie: 0.20, mvp: 0.20,
  championship_year: 0.18, rookie_of_the_year: 0.18, fresh: 0.10, autograph: 0.60,
  "Rookie Year": 0.45, "Rookie Mint": 0.35, "Rookie Premiere": 0.30,
  "Top Shot Debut": 0.25, "Three-Star Rookie": 0.20, "MVP Year": 0.20,
  "Championship Year": 0.18, "Rookie of the Year": 0.18, "Fresh": 0.10,
};
const BADGE_LABELS: Record<string, string> = {
  rookie_year: "Rookie Year", rookie_mint: "Rookie Mint", rookie_premiere: "Rookie Premiere",
  top_shot_debut: "TS Debut", three_star_rookie: "3★ Rookie", mvp: "MVP",
  championship_year: "Champ Year", rookie_of_the_year: "ROTY", fresh: "Fresh", autograph: "Auto",
  "Rookie Year": "Rookie Year", "Rookie Mint": "Rookie Mint", "Rookie Premiere": "Rookie Premiere",
  "Top Shot Debut": "TS Debut", "Three-Star Rookie": "3★ Rookie", "MVP Year": "MVP",
  "Championship Year": "Champ Year", "Rookie of the Year": "ROTY", "Fresh": "Fresh",
};

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

const SERIES_NAMES: Record<number, string> = {
  0: "Beta", 1: "Series 1", 2: "Series 2", 3: "Summer 2021",
  4: "Series 3", 5: "Series 4", 6: "2023-24", 7: "2024-25", 8: "2025-26",
};

const PARALLEL_NAMES: Record<number, string> = {
  0: "Base", 1: "Holo MMXX", 2: "Throwbacks", 3: "Camo", 4: "Metaverse",
  5: "Cosmic", 6: "Ember", 7: "Infinite", 8: "Sapphire", 9: "Ruby",
  10: "Gold", 11: "Super Rare", 12: "Platinum Ice", 13: "Black Ice",
  14: "Bronze", 15: "Silver", 16: "Metallic Gold", 17: "Legendary", 18: "Unique",
};

function serialPremium(serial: number, circ: number): number {
  if (serial === 1) return 12.0;
  if (serial <= 10) return 4.5;
  if (serial <= 23) return 2.8;
  if (serial === circ) return 3.0;
  return Math.max(1.0, Math.pow(circ / 2 / serial, 0.4));
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

interface RawTag { id: string; title: string; }
interface RawTransaction {
  id: string;
  price: string | number;
  updatedAt?: string;
  moment?: {
    id: string;
    flowId: string;
    flowSerialNumber: string;
    tier?: string;
    parallelID?: number;
    assetPathPrefix?: string;
    isLocked?: boolean;
    set?: { id: string; flowName?: string; flowSeriesNumber?: number };
    setPlay?: {
      ID?: string;
      flowRetired?: boolean;
      circulations?: { circulationCount: number; forSaleByCollectors: number };
    };
    parallelSetPlay?: { setID?: string; playID?: string; parallelID?: number };
    play?: {
      id: string;
      stats: { playerName: string; jerseyNumber?: string; teamAtMomentNbaId?: string };
      tags?: RawTag[];
    };
  };
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
  discount: number;
  confidence: string;
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
}

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
                  id
                  price
                  updatedAt
                  moment {
                    id
                    flowId
                    flowSerialNumber
                    tier
                    parallelID
                    assetPathPrefix
                    isLocked
                    set { id flowName flowSeriesNumber }
                    setPlay {
                      ID
                      flowRetired
                      circulations { circulationCount forSaleByCollectors }
                    }
                    parallelSetPlay { setID playID parallelID }
                    play {
                      id
                      stats { playerName jerseyNumber teamAtMomentNbaId }
                      tags { id title }
                    }
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

function parsePrice(p: string | number): number {
  return typeof p === "string" ? parseFloat(p) : (p ?? 0);
}

interface GqlTxResponse {
  errors?: { message: string }[];
  data?: {
    searchMarketplaceTransactions?: {
      data?: {
        searchSummary?: {
          pagination?: { rightCursor?: string };
          data?: { data?: RawTransaction[]; size?: number };
        };
      };
    };
  };
}

async function fetchPage(
  cursor: string,
  sortBy: string
): Promise<{ txns: RawTransaction[]; nextCursor: string | null }> {
  const res = await fetch(TOPSHOT_GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({
      operationName: "SearchMarketplaceTransactions",
      query: SEARCH_TX_QUERY,
      variables: {
        input: {
          sortBy, filters: {},
          searchInput: { pagination: { cursor, direction: "RIGHT", limit: 100 } },
        },
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GQL ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json() as GqlTxResponse;
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
  const summary = json?.data?.searchMarketplaceTransactions?.data?.searchSummary;
  return {
    txns: (summary?.data?.data ?? []) as RawTransaction[],
    nextCursor: summary?.pagination?.rightCursor ?? null,
  };
}

async function fetchTransactionPool(): Promise<RawTransaction[]> {
  const seen = new Set<string>();
  const all: RawTransaction[] = [];
  function add(txns: RawTransaction[]) {
    for (const tx of txns) {
      const k = tx.moment?.id ?? tx.id;
      if (!seen.has(k)) { seen.add(k); all.push(tx); }
    }
  }
  const { txns: p1, nextCursor: c1 } = await fetchPage("", "UPDATED_AT_DESC");
  add(p1);
  if (c1) {
    try { const { txns: p2 } = await fetchPage(c1, "UPDATED_AT_DESC"); add(p2); }
    catch (e) { console.warn("[sniper-feed] page 2 failed:", e); }
  }
  try { const { txns: cheap } = await fetchPage("", "PRICE_ASC"); add(cheap); }
  catch (e) { console.warn("[sniper-feed] PRICE_ASC page failed:", e); }
  return all;
}

function computeEditionFloors(
  txns: RawTransaction[]
): Map<string, { floor: number; count: number }> {
  const byEdition = new Map<string, number[]>();
  for (const tx of txns) {
    const psp = tx.moment?.parallelSetPlay;
    if (!psp?.setID || !psp?.playID) continue;
    const key = `${psp.setID}:${psp.playID}`;
    const price = parsePrice(tx.price);
    if (!price || price <= 0) continue;
    const arr = byEdition.get(key) ?? [];
    arr.push(price);
    byEdition.set(key, arr);
  }
  const floors = new Map<string, { floor: number; count: number }>();
  for (const [key, prices] of byEdition.entries()) {
    prices.sort((a, b) => a - b);
    floors.set(key, { floor: prices[0], count: prices.length });
  }
  return floors;
}

interface FmvRow {
  edition_key: string;
  fmv: number;
  low_ask: number | null;
  confidence: string;
  pack_listing_id: string | null;
  pack_name: string | null;
}

async function fetchSupabaseFmv(
  supabase: SupabaseClient,
  externalIds: string[]
): Promise<Map<string, FmvRow>> {
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
    .select("edition_id, fmv_usd, floor_price_usd, confidence, computed_at")
    .in("edition_id", Array.from(extToSup.values()))
    .order("computed_at", { ascending: false });

  if (!fmvRows?.length) return new Map();

  const seen = new Set<string>();
  const map = new Map<string, FmvRow>();

  for (const row of fmvRows as {
    edition_id: string; fmv_usd: number;
    floor_price_usd: number | null; confidence: string;
  }[]) {
    if (seen.has(row.edition_id)) continue;
    seen.add(row.edition_id);
    const externalId = supToExt.get(row.edition_id);
    if (!externalId) continue;
    map.set(externalId, {
      edition_key: externalId,
      fmv: row.fmv_usd,
      low_ask: row.floor_price_usd,
      confidence: (row.confidence ?? "low").toLowerCase(),
      pack_listing_id: null,
      pack_name: null,
    });
  }

  return map;
}

function extractBadges(tx: RawTransaction): string[] {
  return (tx.moment?.play?.tags ?? [])
    .map(t => t.id in BADGE_PREMIUMS ? t.id : t.title in BADGE_PREMIUMS ? t.title : null)
    .filter((s): s is string => s !== null);
}

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

  let allTxns: RawTransaction[] = [];
  try {
    allTxns = await fetchTransactionPool();
  } catch (err) {
    console.error("[sniper-feed] fetch error:", err);
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }

  console.log(`[sniper-feed] pool: ${allTxns.length}`);

  const txns = rarity !== "all"
    ? allTxns.filter(tx => (tx.moment?.tier ?? "").toUpperCase().includes(rarity.toUpperCase()))
    : allTxns;

  const editionFloors = computeEditionFloors(allTxns);
  const editionKeys = Array.from(editionFloors.keys());
  const supabaseFmv = await fetchSupabaseFmv(supabase, editionKeys);
  console.log(`[sniper-feed] Supabase hits: ${supabaseFmv.size}/${editionKeys.length}`);

  const enriched: SniperDeal[] = txns.map((tx): SniperDeal | null => {
    if (!tx.moment) return null;
    const askPrice = parsePrice(tx.price);
    if (!askPrice || askPrice <= 0) return null;

    const m = tx.moment;
    const psp = m.parallelSetPlay;
    const editionKey = psp?.setID && psp?.playID ? `${psp.setID}:${psp.playID}` : null;
    if (!editionKey) return null;

    const floorData = editionFloors.get(editionKey);
    if (!floorData) return null;

    const sbRow = supabaseFmv.get(editionKey);
    let baseFmv: number;
    let confidence: string;
    let packListingId: string | null = null;
    let packName: string | null = null;

    if (sbRow) {
      baseFmv = floorData.count >= 2 ? Math.min(sbRow.fmv, floorData.floor) : sbRow.fmv;
      confidence = sbRow.confidence;
      packListingId = sbRow.pack_listing_id;
      packName = sbRow.pack_name;
    } else if (floorData.count >= 2) {
      baseFmv = floorData.floor;
      confidence = floorData.count >= 5 ? "medium" : "low";
    } else {
      return null;
    }

    const circ = m.setPlay?.circulations?.circulationCount ?? 1000;
    const serial = parseInt(m.flowSerialNumber ?? "0", 10);
    if (!serial) return null;

    const jerseyNumber = m.play?.stats?.jerseyNumber ?? null;
    const badgeSlugs = extractBadges(tx);
    const hasBadge = badgeSlugs.length > 0;
    const totalBadgePremium = badgeSlugs.reduce((s, slug) => s + (BADGE_PREMIUMS[slug] ?? 0), 0);
    const serialMult = serialPremium(serial, circ);
    const isSpecialSerial = serialMult > 1.5;
    const jerseyMatch = jerseyNumber != null && parseInt(jerseyNumber) === serial;
    const isJersey = jerseyMatch || (serial >= 2 && serial <= 99);
    const adjustedFmv = baseFmv * serialMult * (1 + totalBadgePremium);
    const discount = ((adjustedFmv - askPrice) / adjustedFmv) * 100;
    const parallelId = psp?.parallelID ?? m.parallelID ?? 0;
    const teamId = m.play?.stats?.teamAtMomentNbaId ?? "";
    const teamName = NBA_TEAMS[teamId] ?? teamId;
    const tierRaw = (m.tier ?? "COMMON").replace("MOMENT_TIER_", "");
    const thumbnailUrl = buildThumbnailUrl(m.assetPathPrefix);
    const updatedAt = tx.updatedAt ?? null;

    return {
      flowId: m.flowId,
      momentId: m.id,
      editionKey,
      playerName: m.play?.stats?.playerName ?? "Unknown",
      teamName,
      setName: m.set?.flowName ?? "",
      seriesName: formatSeries(m.set?.flowSeriesNumber),
      tier: tierRaw,
      parallel: formatParallel(parallelId),
      parallelId,
      serial,
      circulationCount: circ,
      askPrice,
      baseFmv,
      adjustedFmv,
      discount: Math.round(discount * 10) / 10,
      confidence,
      hasBadge,
      badgeSlugs,
      badgeLabels: badgeSlugs.map(s => BADGE_LABELS[s] ?? s),
      badgePremiumPct: Math.round(totalBadgePremium * 100),
      serialMult: Math.round(serialMult * 100) / 100,
      isSpecialSerial,
      isJersey,
      serialSignal:
        serial === 1 ? "Serial #1"
        : serial === circ ? "Last Mint"
        : jerseyMatch ? `Jersey #${serial}`
        : isSpecialSerial ? `Low #${serial}`
        : null,
      thumbnailUrl,
      isLocked: m.isLocked ?? false,
      updatedAt,
      packListingId,
      packName,
      packEv: null,
      packEvRatio: null,
      buyUrl: `https://nbatopshot.com/moment/${m.flowId}`,
    };
  }).filter((m): m is SniperDeal => m !== null);

  // Apply filters
  const filtered = enriched.filter(m => {
    if (m.discount < minDiscount) return false;
    if (badgeOnly && !m.hasBadge) return false;
    if (maxPrice > 0 && m.askPrice > maxPrice) return false;
    if (serialFilter === "special" && !m.isSpecialSerial) return false;
    if (serialFilter === "jersey" && !m.isJersey) return false;
    return true;
  });

  // Default sort: newest listed first (updatedAt desc)
  // Client can re-sort by discount — we return all 200 so client sort works on full set
  const deals = filtered
    .sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 200);

  console.log(`[sniper-feed] enriched: ${enriched.length}, deals: ${deals.length}`);
  return NextResponse.json({
    count: deals.length,
    lastRefreshed: new Date().toISOString(),
    deals,
  });
}