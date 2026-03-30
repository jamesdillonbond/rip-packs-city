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
  flowSerialNumber?: number;
  storefrontListingID?: string;
  sellerAddress?: string;
  // Flowty-specific (when merged from flowty-listings)
  source?: "topshot" | "flowty";
  flowId?: string;
  buyUrl?: string;
  playerName?: string;
  teamName?: string;
  seriesName?: string;
  parallel?: string;
  parallelId?: number;
  listingResourceID?: string;
  storefrontAddress?: string;
  thumbnailUrl?: string;
  tier?: string;
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

interface SniperDeal {
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
const FLOWTY_BASE = "https://api.flowty.io";

const TIER_ORDER: Record<string, number> = {
  COMMON: 1,
  FANDOM: 2,
  RARE: 3,
  LEGENDARY: 4,
  ULTIMATE: 5,
};

// Serial premium multipliers — tightened model
function serialMultiplier(
  serial: number,
  circulationCount: number,
  isJersey: boolean
): { mult: number; signal: string | null; isSpecial: boolean } {
  if (serial === 1) return { mult: 8, signal: "#1", isSpecial: true };
  if (isJersey)
    return { mult: 2.5, signal: `Jersey #${serial}`, isSpecial: true };
  if (serial === circulationCount)
    return { mult: 1.3, signal: `Last #${serial}`, isSpecial: true };

  // Low serial tiers (relative to circulation)
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
    rarity !== "all" ? `momentTier: { value: "${rarity.toUpperCase()}" }` : "";
  const teamFilter = team !== "all" ? `teamAtMoment: { value: "${team}" }` : "";

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
        console.warn(`[sniper-feed] TS page offset=${offset} failed after ${retries + 1} attempts:`, err);
        return [];
      }
      // Exponential back-off: 200ms, 400ms
      await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
    }
  }
  return [];
}

async function fetchLiveListings(
  rarity: string,
  team: string
): Promise<{ transactions: RawTransaction[]; tsCount: number }> {
  // Fire 4 pages in parallel with retry
  const pages = await Promise.all([
    fetchTSPageWithRetry(rarity, team, 0),
    fetchTSPageWithRetry(rarity, team, 50),
    fetchTSPageWithRetry(rarity, team, 100),
    fetchTSPageWithRetry(rarity, team, 150),
  ]);
  const transactions = pages.flat();
  return { transactions, tsCount: transactions.length };
}

// ─── Flowty listings helper ───────────────────────────────────────────────────

interface FlowtyListing {
  flowId: string;
  momentId: string;
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
  buyUrl: string;
  listingResourceID: string;
  storefrontAddress: string;
  thumbnailUrl: string | null;
  setId: number;
  playId: number;
}

async function fetchFlowtyListings(
  rarity: string,
  maxPrice: number
): Promise<FlowtyListing[]> {
  const tierMap: Record<string, string> = {
    common: "COMMON",
    fandom: "FANDOM",
    rare: "RARE",
    legendary: "LEGENDARY",
    ultimate: "ULTIMATE",
  };

  try {
    const params = new URLSearchParams({
      collection: "nbatopshot",
      sort: "PRICE_ASC",
      pageSize: "200",
    });
    if (rarity !== "all" && tierMap[rarity.toLowerCase()]) {
      params.set("tier", tierMap[rarity.toLowerCase()]);
    }
    if (maxPrice > 0) {
      params.set("maxPrice", String(maxPrice));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${FLOWTY_BASE}/v1/listings?${params}`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const json = await res.json();
    const listings: FlowtyListing[] = [];
    for (const item of json?.data ?? []) {
      listings.push({
        flowId: String(item.nftId ?? item.flowId ?? ""),
        momentId: String(item.nftId ?? ""),
        playerName: item.playerName ?? item.player_name ?? "",
        teamName: item.teamName ?? item.team_abbreviation ?? "",
        setName: item.setName ?? item.set_name ?? "",
        seriesName: item.seriesName ?? item.series_name ?? "",
        tier: (item.tier ?? "COMMON").toUpperCase(),
        parallel: item.parallel ?? "Base",
        parallelId: item.parallelId ?? 0,
        serial: item.serialNumber ?? item.serial ?? 0,
        circulationCount: item.circulationCount ?? item.circulation_count ?? 0,
        askPrice: item.price ?? item.askPrice ?? 0,
        buyUrl: `https://www.flowty.io/listing/${item.listingId ?? item.listing_id ?? ""}`,
        listingResourceID: String(item.listingId ?? item.listing_id ?? ""),
        storefrontAddress: item.seller ?? item.sellerAddress ?? "",
        thumbnailUrl: item.thumbnailUrl ?? item.thumbnail_url ?? null,
        setId: item.setId ?? 0,
        playId: item.playId ?? 0,
      });
    }
    return listings;
  } catch (err) {
    console.warn("[sniper-feed] Flowty listings fetch failed:", err);
    return [];
  }
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
  if (item.flowId) keys.push(item.flowId);
  if (item.setId && item.playId) {
    const parallelId = item.parallelId ?? 0;
    if (parallelId > 0) {
      keys.push(`${item.setId}:${item.playId}::${parallelId}`);
      keys.push(`${item.setId}:${item.playId}::Parallel${parallelId}`);
    }
    keys.push(`${item.setId}:${item.playId}::Base`);
    keys.push(`${item.setId}:${item.playId}`);
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

function resolveFmv(keys: string[], map: Map<string, FmvRow>): FmvRow | null {
  for (const key of keys) {
    const row = map.get(key);
    if (row) return row;
  }
  return null;
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

const BADGE_LABELS: Record<string, string> = {
  "top-shot-debut": "Top Shot Debut",
  "rookie-year": "Rookie Year",
  "rookie-premiere": "Rookie Premiere",
  "rookie-mint": "Rookie Mint",
  "championship": "Championship",
  "mvp": "MVP",
  "roy": "ROY",
};

function extractBadgeSlugs(tags: Array<{ title?: string }> | undefined): string[] {
  if (!tags) return [];
  return tags
    .map((t) => t.title ?? "")
    .filter((s) => s in BADGE_LABELS);
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
      fetchFlowtyListings(rarity, maxPrice),
    ]);

  // 2. Build all edition keys for batch FMV lookup
  const tsKeys = Array.from(new Set(tsTransactions.flatMap(buildEditionKeys)));
  const flowtyKeys = Array.from(
    new Set(flowtyListings.flatMap(buildFlowtyEditionKeys))
  );
  const allKeys = Array.from(new Set([...tsKeys, ...flowtyKeys]));

  const fmvMap = await fetchFmvBatch(supabase, allKeys);

  // 3. Enrich TS listings
  const tsDeals: SniperDeal[] = [];
  for (const m of tsTransactions) {
    const askRaw = m.flowRetailPrice?.value ?? String(m.marketplacePrice ?? 0);
    const askPrice = parseFloat(askRaw) / 100_000_000;
    if (askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tier = m.momentTier ?? "COMMON";
    const parallelId = m.setPlay?.parallelID ?? 0;
    const parallel = parallelId > 0 ? `Parallel${parallelId}` : "Base";
    const serial = m.serialNumber ?? 0;
    const circ = m.circulationCount ?? 0;

    const isJersey = (m.tags ?? []).some(
      (t) => t.title === "Jersey Match" || t.title === "Jersey Number"
    );
    const { mult: serialMult, signal: serialSignal, isSpecial: isSpecialSerial } =
      serialMultiplier(serial, circ, isJersey);

    const badgeSlugs = extractBadgeSlugs(m.tags);
    const badgeLabels = badgeSlugs.map((s) => BADGE_LABELS[s] ?? s);
    const hasBadge = badgeSlugs.length > 0;

    const editionKeys = buildEditionKeys(m);
    const fmvRow = resolveFmv(editionKeys, fmvMap);
    const baseFmv = fmvRow?.fmv ?? askPrice;
    const confidence = fmvRow?.confidence ?? "low";
    const confidenceSource = fmvRow ? "supabase" : "ask_fallback";
    const adjustedFmv = baseFmv * serialMult;

    const discount = askPrice >= adjustedFmv
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
    const askPrice = item.askPrice;
    if (askPrice <= 0) continue;

    const tier = item.tier ?? "COMMON";
    const serial = item.serial ?? 0;
    const circ = item.circulationCount ?? 0;
    const isJersey = false; // Flowty doesn't return jersey tag directly
    const { mult: serialMult, signal: serialSignal, isSpecial: isSpecialSerial } =
      serialMultiplier(serial, circ, isJersey);

    const editionKeys = buildFlowtyEditionKeys(item);
    const fmvRow = resolveFmv(editionKeys, fmvMap);
    const baseFmv = fmvRow?.fmv ?? askPrice;
    const confidence = fmvRow?.confidence ?? "low";
    const confidenceSource = fmvRow ? "supabase" : "ask_fallback";
    const adjustedFmv = baseFmv * serialMult;

    const discount = askPrice >= adjustedFmv
      ? 0
      : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;
    if (discount < minDiscount) continue;
    if (badgeOnly) continue; // Flowty doesn't carry badge data
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey") continue; // skip jersey filter for Flowty

    // Team filter
    if (team !== "all" && item.teamName !== team) continue;
    if (rarity !== "all" && tier.toLowerCase() !== rarity.toLowerCase()) continue;

    flowtyDeals.push({
      flowId: item.flowId,
      momentId: item.momentId,
      editionKey: editionKeys[0] ?? "",
      playerName: item.playerName,
      teamName: item.teamName,
      setName: item.setName,
      seriesName: item.seriesName,
      tier,
      parallel: item.parallel,
      parallelId: item.parallelId,
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
      thumbnailUrl: item.thumbnailUrl ?? `https://assets.nbatopshot.com/media/${item.momentId}?width=512`,
      isLocked: false,
      updatedAt: new Date().toISOString(),
      packListingId: fmvRow?.pack_listing_id ?? null,
      packName: fmvRow?.pack_name ?? null,
      packEv: null,
      packEvRatio: null,
      buyUrl: item.buyUrl,
      listingResourceID: item.listingResourceID,
      storefrontAddress: item.storefrontAddress,
      source: "flowty",
    });
  }

  // 5. Merge, deduplicate by flowId, and sort
  const seen = new Set<string>();
  const allDeals: SniperDeal[] = [];
  // TS takes priority for dedup
  for (const d of [...tsDeals, ...flowtyDeals]) {
    if (!seen.has(d.flowId)) {
      seen.add(d.flowId);
      allDeals.push(d);
    }
  }

  // 6. Collect pack EV
  const packIds = Array.from(
    new Set(allDeals.map((d) => d.packListingId).filter(Boolean) as string[])
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
    // Default: discount desc
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
        // Stale-while-revalidate: serve cached for up to 25s, then revalidate
        "Cache-Control": "public, max-age=0, s-maxage=25, stale-while-revalidate=60",
      },
    }
  );
}