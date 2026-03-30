import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SetPlay {
  setID: number;
  playID: number;
  parallelID?: number;
}

interface RawTransaction {
  id: string;
  flowRetailPrice?: { value: string };
  marketplacePrice?: number;
  setPlay: SetPlay;
  serialNumber: number;
  circulationCount: number;
  setName?: string;
  momentTier?: string;
  momentTitle?: string;
  tags?: Array<{ title?: string }>;
  storefrontListingID?: string;
  sellerAddress?: string;
}

interface FmvRow {
  edition_key: string;
  fmv: number;
  low_ask: number | null;
  confidence: string;
  set_id: number | null;
  play_id: number | null;
  pack_listing_id: string | null;
  pack_name: string | null;
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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TS_GQL = "https://public-api.nbatopshot.com/graphql";

// Confirmed working Flowty endpoint from DevTools inspection
const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
};

const BADGE_LABELS: Record<string, string> = {
  "top-shot-debut": "Top Shot Debut",
  "rookie-year": "Rookie Year",
  "rookie-premiere": "Rookie Premiere",
  "rookie-mint": "Rookie Mint",
  championship: "Championship",
  mvp: "MVP",
  roy: "ROY",
};

// Series number → display name
const SERIES_NAMES: Record<number, string> = {
  0: "Beta",
  1: "S1",
  2: "S2",
  3: "S3",
  4: "S4",
  5: "S5",
  6: "S6",
  7: "S7",
  8: "S8",
};

// Team full name → abbreviation map for Flowty
const TEAM_ABBREV: Record<string, string> = {
  "Atlanta Hawks": "ATL",
  "Boston Celtics": "BOS",
  "Brooklyn Nets": "BKN",
  "Charlotte Hornets": "CHA",
  "Chicago Bulls": "CHI",
  "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL",
  "Denver Nuggets": "DEN",
  "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW",
  "Houston Rockets": "HOU",
  "Indiana Pacers": "IND",
  "Los Angeles Clippers": "LAC",
  "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM",
  "Miami Heat": "MIA",
  "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN",
  "New Orleans Pelicans": "NOP",
  "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC",
  "Orlando Magic": "ORL",
  "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX",
  "Portland Trail Blazers": "POR",
  "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS",
  "Toronto Raptors": "TOR",
  "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
};

// ─── Serial premium model ─────────────────────────────────────────────────────

function serialMultiplier(
  serial: number,
  circulationCount: number,
  isJersey: boolean
): { mult: number; signal: string | null; isSpecial: boolean } {
  if (serial === 1) return { mult: 8, signal: "#1", isSpecial: true };
  if (isJersey) return { mult: 2.5, signal: `Jersey #${serial}`, isSpecial: true };
  if (serial === circulationCount)
    return { mult: 1.3, signal: `Last #${serial}`, isSpecial: true };

  const pct = serial / circulationCount;
  if (pct <= 0.01) return { mult: 2.2, signal: `Low #${serial}`, isSpecial: true };
  if (pct <= 0.05) return { mult: 1.8, signal: `Low #${serial}`, isSpecial: true };
  if (pct <= 0.1) return { mult: 1.5, signal: `Low #${serial}`, isSpecial: true };
  if (pct <= 0.2) return { mult: 1.3, signal: `Low #${serial}`, isSpecial: true };
  if (pct <= 0.33) return { mult: 1.17, signal: null, isSpecial: false };
  return { mult: 1, signal: null, isSpecial: false };
}

// ─── Top Shot GQL helpers ─────────────────────────────────────────────────────

async function fetchTSPageWithRetry(
  rarity: string,
  team: string,
  offset: number,
  retries = 2
): Promise<RawTransaction[]> {
  const rarityFilter =
    rarity !== "all"
      ? `momentTier: { value: "${rarity.toUpperCase()}" }`
      : "";
  const teamFilter =
    team !== "all" ? `teamAtMoment: { value: "${team}" }` : "";

  const query = `query {
    searchMomentListings(
      input: {
        filters: {
          byListings: {
            listingType: { value: FOR_SALE }
            ${rarityFilter}
            ${teamFilter}
          }
        }
        sortBy: PRICE_ASC
        first: 50
        after: "${offset}"
      }
    ) {
      data {
        searchSummary { pagination { cursor size } }
        momentListings {
          id
          flowRetailPrice { value }
          serialNumber
          circulationCount
          setName
          momentTier
          momentTitle
          tags { title }
          storefrontListingID
          sellerAddress
          setPlay { setID playID parallelID }
        }
      }
    }
  }`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(TS_GQL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`TS GQL ${res.status}`);
      const json = await res.json();
      return (
        json?.data?.searchMomentListings?.data?.momentListings ?? []
      ) as RawTransaction[];
    } catch (err) {
      if (attempt === retries) {
        console.warn(
          `[sniper-feed] TS page offset=${offset} failed after ${retries + 1} attempts:`,
          err
        );
        return [];
      }
      await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
    }
  }
  return [];
}

async function fetchLiveListings(
  rarity: string,
  team: string
): Promise<{ transactions: RawTransaction[]; tsCount: number }> {
  const pages = await Promise.all([
    fetchTSPageWithRetry(rarity, team, 0),
    fetchTSPageWithRetry(rarity, team, 50),
    fetchTSPageWithRetry(rarity, team, 100),
    fetchTSPageWithRetry(rarity, team, 150),
  ]);
  const transactions = pages.flat();
  return { transactions, tsCount: transactions.length };
}

// ─── Flowty helpers ───────────────────────────────────────────────────────────

interface FlowtyNft {
  id: string;
  serialNumber?: number;
  setID?: number;
  playID?: number;
  subeditionID?: number;
  editionName?: string;
  setName?: string;
  playerFullName?: string;
  teamAtMoment?: string;
  playCategory?: string;
  momentTier?: string;
  seriesNumber?: number;
}

interface FlowtyListing {
  nft: FlowtyNft;
  listingResourceID: string;
  storefrontAddress: string;
  price: number; // already in USD
  valuations?: { blended?: { usdValue?: number } };
  blockTimestamp?: number; // milliseconds
}

async function fetchFlowtyPage(from: number): Promise<FlowtyListing[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null,
        addresses: [],
        collectionFilters: [
          { collection: "0x0b2a3299cc857e29.TopShot", traits: [] },
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
          path: "price",
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const json = await res.json();
    return (json?.data ?? []) as FlowtyListing[];
  } catch (err) {
    console.warn(`[sniper-feed] Flowty page from=${from} failed:`, err);
    return [];
  }
}

async function fetchAllFlowtyListings(): Promise<FlowtyListing[]> {
  // Fetch 4 pages (96 listings) in parallel — sorted by price ASC
  const pages = await Promise.all([
    fetchFlowtyPage(0),
    fetchFlowtyPage(24),
    fetchFlowtyPage(48),
    fetchFlowtyPage(72),
  ]);
  return pages.flat();
}

// ─── Edition key builders ─────────────────────────────────────────────────────

function buildEditionKeys(m: RawTransaction): string[] {
  const keys: string[] = [];
  if (m.id) keys.push(m.id);
  if (m.setPlay) {
    const sp = m.setPlay;
    const parallelId = sp.parallelID ?? 0;
    if (parallelId > 0) {
      keys.push(`${sp.setID}:${sp.playID}::${parallelId}`);
      keys.push(`${sp.setID}:${sp.playID}::Parallel${parallelId}`);
    }
    keys.push(`${sp.setID}:${sp.playID}::Base`);
    keys.push(`${sp.setID}:${sp.playID}`);
  }
  return keys;
}

function buildFlowtyEditionKeys(item: FlowtyListing): string[] {
  const keys: string[] = [];
  const nft = item.nft;
  if (nft.id) keys.push(nft.id);
  if (nft.setID && nft.playID) {
    const subId = nft.subeditionID ?? 0;
    if (subId > 0) {
      keys.push(`${nft.setID}:${nft.playID}::${subId}`);
      keys.push(`${nft.setID}:${nft.playID}::Parallel${subId}`);
    }
    keys.push(`${nft.setID}:${nft.playID}::Base`);
    keys.push(`${nft.setID}:${nft.playID}`);
  }
  return keys;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function fetchFmvBatch(
  supabase: SupabaseClient,
  editionKeys: string[]
): Promise<Map<string, FmvRow>> {
  if (editionKeys.length === 0) return new Map();
  const { data } = await supabase
    .from("fmv_snapshots")
    .select(
      "edition_key, fmv, low_ask, confidence, set_id, play_id, pack_listing_id, pack_name"
    )
    .in("edition_key", editionKeys)
    .order("computed_at", { ascending: false });

  const map = new Map<string, FmvRow>();
  for (const row of (data ?? []) as FmvRow[]) {
    if (!map.has(row.edition_key)) map.set(row.edition_key, row);
  }
  return map;
}

async function fetchPackEvBatch(
  supabase: SupabaseClient,
  packIds: string[]
): Promise<Map<string, PackEvRow>> {
  if (packIds.length === 0) return new Map();
  const { data } = await supabase
    .from("pack_ev_cache")
    .select("pack_listing_id, pack_name, pack_price, ev, ev_ratio")
    .in("pack_listing_id", packIds);
  const map = new Map<string, PackEvRow>();
  for (const row of (data ?? []) as PackEvRow[]) {
    map.set(row.pack_listing_id, row);
  }
  return map;
}

function resolveFmv(
  keys: string[],
  map: Map<string, FmvRow>
): FmvRow | null {
  for (const key of keys) {
    const row = map.get(key);
    if (row) return row;
  }
  return null;
}

function extractBadgeSlugs(
  tags: Array<{ title?: string }> | undefined
): string[] {
  if (!tags) return [];
  return tags.map((t) => t.title ?? "").filter((s) => s in BADGE_LABELS);
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

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

  // 1. Fetch TS + Flowty in parallel
  const [{ transactions: tsTransactions, tsCount }, flowtyListings] =
    await Promise.all([
      fetchLiveListings(rarity, team),
      fetchAllFlowtyListings(),
    ]);

  // 2. Build all edition keys for batch FMV lookup
  const tsKeys = Array.from(
    new Set(tsTransactions.flatMap(buildEditionKeys))
  );
  const flowtyKeys = Array.from(
    new Set(flowtyListings.flatMap(buildFlowtyEditionKeys))
  );
  const allKeys = Array.from(new Set([...tsKeys, ...flowtyKeys]));

  const fmvMap = await fetchFmvBatch(supabase, allKeys);

  // 3. Enrich TS listings
  const tsDeals: SniperDeal[] = [];
  for (const m of tsTransactions) {
    const askRaw =
      m.flowRetailPrice?.value ?? String(m.marketplacePrice ?? 0);
    const askPrice = parseFloat(askRaw) / 100_000_000;
    if (askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tier = m.momentTier ?? "COMMON";
    const parallelId = m.setPlay?.parallelID ?? 0;
    const parallel = parallelId > 0 ? `Parallel${parallelId}` : "Base";
    const serial = m.serialNumber ?? 0;
    const circ = m.circulationCount ?? 0;

    const isJersey = (m.tags ?? []).some(
      (t) =>
        t.title === "Jersey Match" || t.title === "Jersey Number"
    );
    const {
      mult: serialMult,
      signal: serialSignal,
      isSpecial: isSpecialSerial,
    } = serialMultiplier(serial, circ, isJersey);

    const badgeSlugs = extractBadgeSlugs(m.tags);
    const badgeLabels = badgeSlugs.map((s) => BADGE_LABELS[s] ?? s);
    const hasBadge = badgeSlugs.length > 0;

    const editionKeys = buildEditionKeys(m);
    const fmvRow = resolveFmv(editionKeys, fmvMap);
    const baseFmv = fmvRow?.fmv ?? askPrice;
    const confidence = fmvRow?.confidence ?? "low";
    const confidenceSource = fmvRow ? "supabase" : "ask_fallback";
    const adjustedFmv = baseFmv * serialMult;

    const discount =
      askPrice >= adjustedFmv
        ? 0
        : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;
    if (discount < minDiscount) continue;
    if (badgeOnly && !hasBadge) continue;
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey" && !isJersey) continue;

    tsDeals.push({
      flowId: m.id,
      momentId: m.id,
      editionKey: editionKeys[0] ?? "",
      playerName: m.momentTitle ?? "",
      teamName: "",
      setName: m.setName ?? "",
      seriesName: "",
      tier,
      parallel,
      parallelId,
      serial,
      circulationCount: circ,
      askPrice,
      baseFmv,
      adjustedFmv,
      discount,
      confidence,
      confidenceSource,
      hasBadge,
      badgeSlugs,
      badgeLabels,
      badgePremiumPct: 0,
      serialMult,
      isSpecialSerial,
      isJersey,
      serialSignal,
      thumbnailUrl: `https://assets.nbatopshot.com/media/${m.id}?width=512`,
      isLocked: false,
      updatedAt: new Date().toISOString(),
      packListingId: fmvRow?.pack_listing_id ?? null,
      packName: fmvRow?.pack_name ?? null,
      packEv: null,
      packEvRatio: null,
      buyUrl: `https://nbatopshot.com/moment/${m.id}`,
      listingResourceID: m.storefrontListingID ?? null,
      storefrontAddress: m.sellerAddress ?? null,
      source: "topshot",
    });
  }

  // 4. Enrich Flowty listings
  const flowtyDeals: SniperDeal[] = [];
  for (const item of flowtyListings) {
    const nft = item.nft;
    const askPrice = item.price ?? 0;
    if (askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tier = (nft.momentTier ?? "COMMON").toUpperCase();
    if (rarity !== "all" && tier.toLowerCase() !== rarity.toLowerCase()) continue;

    const serial = nft.serialNumber ?? 0;
    const circ = 0; // Flowty doesn't return circulationCount directly; 0 = no premium calc
    const isJersey = false;
    const {
      mult: serialMult,
      signal: serialSignal,
      isSpecial: isSpecialSerial,
    } = serialMultiplier(serial, circ > 0 ? circ : 99999, isJersey);

    const teamFull = nft.teamAtMoment ?? "";
    const teamName = TEAM_ABBREV[teamFull] ?? teamFull;
    if (team !== "all" && teamName !== team && teamFull !== team) continue;

    const seriesNum = nft.seriesNumber ?? -1;
    const seriesName = SERIES_NAMES[seriesNum] ?? "";

    // LiveToken FMV from Flowty valuation
    const livetokenFmv = item.valuations?.blended?.usdValue ?? null;

    const editionKeys = buildFlowtyEditionKeys(item);
    const fmvRow = resolveFmv(editionKeys, fmvMap);

    // Priority: Supabase FMV → LiveToken FMV → ask price
    const baseFmv = fmvRow?.fmv ?? livetokenFmv ?? askPrice;
    const confidence = fmvRow?.confidence ?? (livetokenFmv ? "medium" : "low");
    const confidenceSource = fmvRow
      ? "supabase"
      : livetokenFmv
      ? "livetoken"
      : "ask_fallback";
    const adjustedFmv = baseFmv * serialMult;

    const discount =
      askPrice >= adjustedFmv
        ? 0
        : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;
    if (discount < minDiscount) continue;
    if (badgeOnly) continue; // Flowty carries no badge data
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey") continue;

    const momentId = String(nft.id ?? "");
    const subId = nft.subeditionID ?? 0;

    flowtyDeals.push({
      flowId: momentId,
      momentId,
      editionKey: editionKeys[0] ?? "",
      playerName: nft.playerFullName ?? "",
      teamName,
      setName: nft.setName ?? nft.editionName ?? "",
      seriesName,
      tier,
      parallel: subId > 0 ? `Parallel${subId}` : "Base",
      parallelId: subId,
      serial,
      circulationCount: circ,
      askPrice,
      baseFmv,
      adjustedFmv,
      discount,
      confidence,
      confidenceSource,
      hasBadge: false,
      badgeSlugs: [],
      badgeLabels: [],
      badgePremiumPct: 0,
      serialMult,
      isSpecialSerial,
      isJersey,
      serialSignal,
      thumbnailUrl: `https://assets.nbatopshot.com/media/${momentId}?width=512`,
      isLocked: false,
      updatedAt:
        item.blockTimestamp
          ? new Date(item.blockTimestamp).toISOString()
          : new Date().toISOString(),
      packListingId: fmvRow?.pack_listing_id ?? null,
      packName: fmvRow?.pack_name ?? null,
      packEv: null,
      packEvRatio: null,
      buyUrl: `https://www.flowty.io/listing/${item.listingResourceID}`,
      listingResourceID: item.listingResourceID,
      storefrontAddress: item.storefrontAddress,
      source: "flowty",
    });
  }

  // 5. Merge — TS wins on dedup, Flowty fills gaps
  const seen = new Set<string>();
  const allDeals: SniperDeal[] = [];
  for (const d of [...tsDeals, ...flowtyDeals]) {
    if (!seen.has(d.flowId)) {
      seen.add(d.flowId);
      allDeals.push(d);
    }
  }

  // 6. Pack EV enrichment
  const packIds = Array.from(
    new Set(
      allDeals
        .map((d) => d.packListingId)
        .filter(Boolean) as string[]
    )
  );
  const packMap = await fetchPackEvBatch(supabase, packIds);
  for (const d of allDeals) {
    if (d.packListingId) {
      const pev = packMap.get(d.packListingId);
      if (pev) {
        d.packEv = pev.ev;
        d.packEvRatio = pev.ev_ratio;
      }
    }
  }

  // 7. Sort
  const sorted = allDeals.sort((a, b) => {
    if (sortBy === "price_asc") return a.askPrice - b.askPrice;
    if (sortBy === "price_desc") return b.askPrice - a.askPrice;
    if (sortBy === "fmv_desc") return b.adjustedFmv - a.adjustedFmv;
    if (sortBy === "serial_asc") return a.serial - b.serial;
    return b.discount - a.discount;
  });

  return NextResponse.json(
    {
      count: sorted.length,
      tsCount,
      flowtyCount: flowtyListings.length,
      lastRefreshed: new Date().toISOString(),
      deals: sorted,
    },
    {
      headers: {
        "Cache-Control":
          "public, max-age=0, s-maxage=25, stale-while-revalidate=60",
      },
    }
  );
}