import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getOrSetCache } from "@/lib/cache";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawListing {
  id: string;
  flowRetailPrice?: { value: string };
  moment: {
    id: string;
    tier: string;
    playerName: string;
    teamName: string;
    setName: string;
    season: string;
    serialNumber: number;
    circulationCount: number;
    editionID: string;
    storefrontListingID?: string;
    sellerAddress?: string;
    tags?: Array<{ id?: string; title?: string }>;
  };
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
  season: string;
  tier: string;
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
  serialMult: number;
  isSpecialSerial: boolean;
  isJersey: boolean;
  serialSignal: string | null;
  thumbnailUrl: string | null;
  updatedAt: string | null;
  packListingId: string | null;
  packName: string | null;
  packEv: number | null;
  packEvRatio: number | null;
  buyUrl: string;
  listingResourceID: string | null;
  listingOrderID: string | null;
  storefrontAddress: string | null;
  source: "allday" | "flowty";
  paymentToken: "DUC" | "FUT" | "FLOW" | "USDC_E";
  offerAmount: number | null;
  offerFmvPct: number | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLDAY_GQL = "https://public-api.nflallday.com/graphql";
const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
};

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0xe4cf4bdc1751c65d/AllDay";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
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

// ─── All Day GQL ──────────────────────────────────────────────────────────────

const SEARCH_LISTINGS_QUERY = `
  {
    searchMomentListings(input: {
      filters: { byListings: { listingType: { value: FOR_SALE } } }
      searchInput: { pagination: { cursor: "", direction: RIGHT, count: 100 } }
    }) {
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
                  moment {
                    id tier playerName teamName setName season
                    serialNumber circulationCount editionID
                    storefrontListingID sellerAddress
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
`;

function parseListingPrice(listing: RawListing): number {
  if (listing.flowRetailPrice?.value) {
    return parseFloat(listing.flowRetailPrice.value) / 100_000_000;
  }
  return 0;
}

async function fetchAllDayPage(
  cursor: string
): Promise<{ listings: RawListing[]; nextCursor: string | null }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(ALLDAY_GQL, {
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
    console.log(`[allday-sniper-feed] AllDay page listings=${listings.length}`);
    return { listings, nextCursor };
  } catch (err) {
    console.error(`[allday-sniper-feed] AllDay page FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return { listings: [], nextCursor: null };
  }
}

async function fetchAllDayPool(): Promise<{ listings: RawListing[]; alldayCount: number }> {
  const seen = new Set<string>();
  const all: RawListing[] = [];
  function add(listings: RawListing[]) {
    for (const l of listings) {
      if (!seen.has(l.id)) { seen.add(l.id); all.push(l); }
    }
  }

  const [r1] = await Promise.allSettled([
    fetchAllDayPage(""),
  ]);

  if (r1.status === "fulfilled") add(r1.value.listings);

  console.log(`[allday-sniper-feed] AllDay pool: p1=${r1.status === "fulfilled" ? r1.value.listings.length : "FAIL"} total=${all.length}`);
  return { listings: all, alldayCount: all.length };
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
  season: string;
  editionID: string;
  isLocked: boolean;
  paymentToken: "DUC" | "FUT" | "FLOW" | "USDC_E";
}

// Multi-key trait lookup: tries each key name variant in order
const FLOWTY_TRAIT_MAP: Record<string, string[]> = {
  setName:    ["SetName", "setName", "Set Name", "set_name"],
  teamName:   ["TeamName", "teamName", "Team Name", "team_name", "Team", "team"],
  tier:       ["Tier", "tier", "MomentTier", "momentTier"],
  season:     ["Season", "season"],
  locked:     ["Locked", "locked", "IsLocked", "isLocked"],
  fullName:   ["PlayerName", "playerName", "FullName", "fullName", "Full Name", "Player Name"],
  editionID:  ["editionID", "edition_id", "EditionID", "editionId"],
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
        collectionFilters: [{ collection: "0xe4cf4bdc1751c65d.AllDay", traits: [] }],
        from, includeAllListings: true, limit: 24, onlyUnlisted: false,
        orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
        sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) { console.error(`[allday-sniper-feed] Flowty HTTP ${res.status} from=${from}`); return []; }
    const json = await res.json();
    const rawItems: FlowtyNftItem[] = json?.nfts ?? json?.data ?? [];

    // Log actual trait keys from first item so we can verify field names in Vercel logs
    if (from === 0 && rawItems.length > 0) {
      const firstTraits = rawItems[0].nftView?.traits ?? [];
      console.log(`[allday-sniper-feed] Flowty trait keys: ${firstTraits.map(t => t.name).join(", ")}`);
      const sampleSetName = getTraitMulti(firstTraits, FLOWTY_TRAIT_MAP.setName);
      const sampleTeam = getTraitMulti(firstTraits, FLOWTY_TRAIT_MAP.teamName);
      console.log(`[allday-sniper-feed] Flowty sample setName="${sampleSetName}" teamName="${sampleTeam}"`);
    }

    console.log(`[allday-sniper-feed] Flowty from=${from}: rawItems=${rawItems.length}`);
    const listings: FlowtyListing[] = [];
    let nullFmvCount = 0;
    for (const item of rawItems) {
      const order = item.orders?.find((o) => (o.salePrice ?? 0) > 0) ?? item.orders?.[0];
      if (!order?.listingResourceID) continue;
      if (order.salePrice <= 0) continue;
      const traits = item.nftView?.traits ?? [];
      const serial = item.card?.num ?? item.nftView?.serial ?? 0;
      const circ = item.card?.max ?? 0;
      const livetokenFmv = item.valuations?.blended?.usdValue ?? item.valuations?.livetoken?.usdValue ?? null;
      if (!livetokenFmv || livetokenFmv <= 0) { nullFmvCount++; }

      // Normalize vault type to short payment token enum
      const paymentToken = VAULT_TO_PAYMENT_TOKEN[order.salePaymentVaultType ?? ""] ?? "DUC";

      const editionID = getTraitMulti(traits, FLOWTY_TRAIT_MAP.editionID);

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
        season: getTraitMulti(traits, FLOWTY_TRAIT_MAP.season),
        editionID,
        isLocked: getTraitMulti(traits, FLOWTY_TRAIT_MAP.locked) === "true",
        paymentToken,
      });
    }
    if (nullFmvCount > 0) {
      console.log(`[allday-sniper-feed] Flowty from=${from}: ${nullFmvCount}/${rawItems.length} items have null/zero LiveToken FMV`);
    }
    return listings;
  } catch (err) {
    console.error(`[allday-sniper-feed] Flowty from=${from} FAILED: ${err instanceof Error ? err.message : String(err)}`);
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

// ─── Supabase FMV lookup ──────────────────────────────────────────────────────

async function fetchFmvBatch(
  supabase: SupabaseClient,
  editionKeys: string[]
): Promise<Map<string, FmvRow>> {
  if (!editionKeys.length) return new Map();

  const { data: editionRows } = await (supabase as any)
    .from("editions")
    .select("id, external_id")
    .in("external_id", editionKeys);

  if (!editionRows?.length) {
    console.log(`[allday-sniper-feed] Supabase editions: 0 hits for ${editionKeys.length} keys`);
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
    console.log(`[allday-sniper-feed] Supabase FMV: 0 snapshots for ${editionRows.length} editions`);
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

  console.log(`[allday-sniper-feed] Supabase FMV hits: ${map.size}/${editionKeys.length}`);
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
  const { data, error } = await (supabase as any)
    .from("players")
    .select("name, jersey_number")
    .not("jersey_number", "is", null);

  if (error || !data?.length) return new Map();

  const map = new Map<string, number>();
  for (const row of data as { name: string; jersey_number: number }[]) {
    map.set(row.name.toLowerCase().trim(), row.jersey_number);
  }
  console.log(`[allday-sniper-feed] jersey_numbers: ${map.size} players loaded`);
  return map;
}

// ─── Input validation ─────────────────────────────────────────────────────────

const feedParamsSchema = z.object({
  minDiscount: z.coerce.number().min(0).max(100).default(0),
  rarity: z.string().default("all"),
  tier: z.string().default("all"), // alias for rarity — UI sends "tier"
  player: z.string().default(""), // post-fetch filter on playerName
  team: z.string().default("all"),
  serial: z.string().default("all"),
  maxPrice: z.coerce.number().min(0).default(0),
  limit: z.coerce.number().min(1).max(500).default(0), // 0 = no limit
  sortBy: z.enum(["discount", "price_asc", "price_desc", "fmv_desc", "serial_asc"]).default("discount"),
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
  const serialFilter = params.serial;

  // Cache key based on all query params — same params = same response for 25s
  const cacheKey = `allday-sniper-feed:${JSON.stringify(params)}`;
  const CACHE_TTL = 25_000;

  let result = await getOrSetCache(cacheKey, CACHE_TTL, async () => {
    return computeSniperFeed({ minDiscount, rarity: effectiveRarity, team, serialFilter, maxPrice, sortBy });
  }) as { count: number; alldayCount: number; flowtyCount: number; lastRefreshed: string; deals: SniperDeal[]; cached?: boolean };

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
  serialFilter: string; maxPrice: number; sortBy: string;
}) {
  const { minDiscount, rarity, team, serialFilter, maxPrice, sortBy } = opts;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Fetch AllDay listings + Flowty in parallel
  const [{ listings: alldayListings, alldayCount }, flowtyListings] = await Promise.all([
    fetchAllDayPool(),
    fetchAllFlowtyListings(),
  ]);

  console.log(`[allday-sniper-feed] fetched allday=${alldayListings.length} flowty=${flowtyListings.length}`);

  // 2. Build edition keys for Supabase FMV lookup
  //    AllDay edition key format: "allday:{editionID}"
  const alldayEditionKeys = new Set<string>();
  for (const l of alldayListings) {
    if (l.moment?.editionID) {
      alldayEditionKeys.add(`allday:${l.moment.editionID}`);
    }
  }
  // Include Flowty editionIDs so they also get FMV resolved
  for (const l of flowtyListings) {
    if (l.editionID) {
      alldayEditionKeys.add(`allday:${l.editionID}`);
    }
  }

  // 3. Collect unique player names for jersey lookups
  const allPlayerNames = Array.from(new Set([
    ...flowtyListings.map(l => l.playerName).filter(Boolean),
    ...alldayListings.map(l => l.moment?.playerName ?? "").filter(Boolean),
  ]));

  // 4. Fire all Supabase lookups in parallel
  const [fmvMap, jerseyMap, retiredResult] = await Promise.all([
    fetchFmvBatch(supabase, Array.from(alldayEditionKeys)),
    fetchJerseyNumbers(supabase, allPlayerNames),
    (supabase as any).from("moments").select("nft_id").eq("retired", true).eq("collection_slug", "nfl_all_day"),
  ]);
  const retiredIds = new Set<string>(
    (retiredResult?.data ?? []).map((r: { nft_id: string }) => String(r.nft_id))
  );
  console.log(`[allday-sniper-feed] retiredIds size=${retiredIds.size}`);

  // 5. Enrich AllDay marketplace listings
  const alldayDeals: SniperDeal[] = [];
  for (const l of alldayListings) {
    const askPrice = parseListingPrice(l);
    if (!askPrice || askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const moment = l.moment;
    if (!moment) continue;

    const tierRaw = (moment.tier ?? "COMMON").toUpperCase();
    if (rarity !== "all" && tierRaw.toUpperCase() !== rarity.toUpperCase()) continue;

    const editionID = moment.editionID;
    if (!editionID) continue;
    const editionKey = `allday:${editionID}`;

    const serial = moment.serialNumber ?? 0;
    if (!serial) continue;
    const circ = moment.circulationCount ?? 1000;

    const playerNameRaw = moment.playerName ?? "Unknown";
    const jerseyNumber = jerseyMap.get(playerNameRaw.toLowerCase().trim()) ?? null;
    const { mult: serialMult, signal: serialSignal, isSpecial: isSpecialSerial } =
      serialMultiplier(serial, circ, jerseyNumber);
    const isJersey = jerseyNumber !== null && serial === jerseyNumber;

    const teamName = moment.teamName ?? "";
    if (team !== "all" && teamName !== team) continue;

    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey" && !isJersey) continue;

    const fmvRow = fmvMap.get(editionKey) ?? null;
    if (!fmvRow) continue;

    const baseFmv = fmvRow.fmv;
    const confidence = fmvRow.confidence;
    const confidenceSource = "supabase";
    const adjustedFmv = baseFmv * serialMult;
    const discount = askPrice >= adjustedFmv
      ? 0
      : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;
    if (discount < minDiscount) continue;

    const thumbnailUrl = `https://media.nflallday.com/editions/${editionID}/media/image?width=150&format=webp`;

    alldayDeals.push({
      flowId: String(l.id),
      momentId: String(moment.id),
      editionKey,
      playerName: playerNameRaw,
      teamName,
      setName: moment.setName ?? "",
      season: moment.season ?? "",
      tier: tierRaw,
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
      serialMult,
      isSpecialSerial,
      isJersey,
      serialSignal,
      thumbnailUrl,
      updatedAt: new Date().toISOString(),
      packListingId: fmvRow.packListingId,
      packName: fmvRow.packName,
      packEv: null,
      packEvRatio: null,
      buyUrl: `https://nflallday.com/listing/${l.id}`,
      listingResourceID: moment.storefrontListingID ?? null,
      listingOrderID: null,
      storefrontAddress: moment.sellerAddress ?? null,
      source: "allday",
      paymentToken: "DUC",
      offerAmount: null,
      offerFmvPct: null,
    });
  }

  // 6. Enrich Flowty listings
  //    FMV priority: LiveToken → Supabase → ask-price fallback
  const flowtyDeals: SniperDeal[] = [];
  let flowtyLivetokenHits = 0, flowtySupabaseHits = 0, flowtyAskFallbacks = 0;
  for (const item of flowtyListings) {
    const askPrice = item.price;
    if (askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tier = item.tier ?? "COMMON";
    if (rarity !== "all" && tier.toLowerCase() !== rarity.toLowerCase()) continue;

    const teamName = item.teamName;
    if (team !== "all" && teamName !== team) continue;

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

    // Resolve editionKey from Flowty trait data
    if (item.editionID) {
      editionKey = `allday:${item.editionID}`;
    }

    if (item.livetokenFmv && item.livetokenFmv > 0) {
      // LiveToken FMV available
      baseFmv = item.livetokenFmv;
      confidence = "medium";
      confidenceSource = "livetoken";
      flowtyLivetokenHits++;
    } else {
      // Try Supabase FMV using editionKey from traits
      if (editionKey) {
        fmvRow = fmvMap.get(editionKey) ?? null;
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

    flowtyDeals.push({
      flowId: item.momentId,
      momentId: item.momentId,
      editionKey,
      playerName: item.playerName,
      teamName,
      setName: item.setName,
      season: item.season,
      tier,
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
      serialMult,
      isSpecialSerial,
      isJersey,
      serialSignal,
      thumbnailUrl: item.editionID
        ? `https://media.nflallday.com/editions/${item.editionID}/media/image?width=150&format=webp`
        : null,
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

  console.log(`[allday-sniper-feed] Flowty FMV sources: livetoken=${flowtyLivetokenHits} supabase=${flowtySupabaseHits} ask_fallback=${flowtyAskFallbacks}`);
  console.log(`[allday-sniper-feed] built allday=${alldayDeals.length} flowty=${flowtyDeals.length}`);

  // 7. Merge — Flowty wins on dedup by flowId, exclude retired moments
  const seen = new Set<string>();
  const allDeals: SniperDeal[] = [];
  for (const d of [...flowtyDeals, ...alldayDeals]) {
    if (!seen.has(d.flowId) && !retiredIds.has(d.flowId)) {
      seen.add(d.flowId);
      allDeals.push(d);
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

  console.log(
    `[allday-sniper-feed] DONE allday=${alldayDeals.length} flowty=${flowtyDeals.length} total=${sorted.length} ` +
    `fmv_hits=${fmvMap.size}`
  );

  // ── CACHE FALLBACK: if live feeds returned 0, read from Supabase cached_listings ──
  if (sorted.length === 0) {
    try {
      const { data: cachedRows } = await supabase
        .from("cached_listings")
        .select("*")
        .eq("collection_slug", "nfl_all_day")
        .gt("discount", 0)
        .order("discount", { ascending: false })
        .limit(200);

      if (cachedRows && cachedRows.length > 0) {
        // Filter out retired moments from cached deals
        const liveCachedRows = cachedRows.filter((r: any) => !retiredIds.has(String(r.flow_id)));
        console.log("[allday-sniper-feed] Live feeds empty, serving " + liveCachedRows.length + " cached deals (filtered " + (cachedRows.length - liveCachedRows.length) + " retired)");
        const cachedDeals = liveCachedRows.map(function (r: any) {
          return {
            flowId: r.flow_id || "",
            momentId: r.moment_id || "",
            editionKey: "",
            playerName: r.player_name || "",
            teamName: r.team_name || "",
            setName: r.set_name || "",
            season: r.season || "",
            tier: r.tier || "COMMON",
            serial: r.serial_number || 0,
            circulationCount: r.circulation_count || 0,
            askPrice: Number(r.ask_price) || 0,
            baseFmv: Number(r.fmv) || 0,
            adjustedFmv: Number(r.adjusted_fmv) || Number(r.fmv) || 0,
            discount: Number(r.discount) || 0,
            confidence: r.confidence || "HIGH",
            confidenceSource: "cached",
            serialMult: 1,
            isSpecialSerial: false,
            isJersey: false,
            serialSignal: null,
            thumbnailUrl: r.thumbnail_url || null,
            updatedAt: r.listed_at || r.cached_at || null,
            packListingId: null,
            packName: null,
            packEv: null,
            packEvRatio: null,
            buyUrl: r.buy_url || "",
            listingResourceID: r.listing_resource_id || null,
            listingOrderID: r.listing_order_id || null,
            storefrontAddress: r.storefront_address || null,
            source: (r.source || "flowty") as "allday" | "flowty",
            paymentToken: (r.payment_token || "DUC") as "DUC" | "FUT" | "FLOW" | "USDC_E",
            offerAmount: null as number | null,
            offerFmvPct: null as number | null,
          };
        });
        return {
          count: cachedDeals.length,
          alldayCount: 0,
          flowtyCount: cachedDeals.length,
          lastRefreshed: new Date().toISOString(),
          deals: cachedDeals,
          cached: true,
        };
      }
    } catch (cacheErr) {
      console.error("[allday-sniper-feed] Cache fallback error: " + cacheErr);
    }
  }

  return {
    count: sorted.length,
    alldayCount,
    flowtyCount: flowtyListings.length,
    lastRefreshed: new Date().toISOString(),
    deals: sorted,
  };
}
