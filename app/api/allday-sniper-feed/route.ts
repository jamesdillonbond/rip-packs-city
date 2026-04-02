import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getOrSetCache } from "@/lib/cache";
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawListing {
  id: string;
  flowRetailPrice?: { value: string };
  moment?: {
    id?: string;
    tier?: string;
    playerName?: string;
    teamName?: string;
    setName?: string;
    season?: string;
    serialNumber?: number;
    circulationCount?: number;
    editionID?: string;
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
  isLocked: boolean;
  updatedAt: string | null;
  buyUrl: string;
  listingResourceID: string | null;
  storefrontAddress: string | null;
  source: "allday" | "flowty";
  paymentToken: "DUC" | "FUT" | "FLOW" | "USDC_E";
  offerAmount: number | null;
  offerFmvPct: number | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AD_GQL = "https://public-api.nflallday.com/graphql";
const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
};

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0xe4cf4bdc1751c65d/AllDay";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

const VAULT_TO_PAYMENT_TOKEN: Record<string, "DUC" | "FUT" | "FLOW" | "USDC_E"> = {
  "A.ead892083b3e2c6c.DapperUtilityCoin.Vault": "DUC",
  "A.609e10301860b683.FlowUtilityToken.Vault": "FUT",
  "A.7e60df042a9c0868.FlowToken.Vault": "FLOW",
  "A.f1ab99c82dee3526.USDCFlow.Vault": "USDC_E",
};

// ─── Serial premium model ─────────────────────────────────────────────────────

function serialMultiplier(
  serial: number,
  circulationCount: number,
  jerseyNumber: number | null
): { mult: number; signal: string | null; isSpecial: boolean } {
  if (serial === 1) return { mult: 8, signal: "#1", isSpecial: true };
  if (jerseyNumber !== null && serial === jerseyNumber)
    return { mult: 2.5, signal: "Jersey #" + serial, isSpecial: true };
  if (serial === circulationCount)
    return { mult: 1.3, signal: "Last #" + serial, isSpecial: true };
  return { mult: 1, signal: null, isSpecial: false };
}

function buildThumbnailUrl(editionID: string | null | undefined): string | null {
  if (!editionID) return null;
  return "https://media.nflallday.com/editions/" + editionID + "/media/image?width=150&format=webp";
}

// ─── All Day GQL ──────────────────────────────────────────────────────────────

const SEARCH_LISTINGS_QUERY = "{\n  searchMomentListings(\n    input: {\n      filters: { byListings: { listingType: { value: FOR_SALE } } }\n      searchInput: { pagination: { cursor: \"\", direction: RIGHT, count: 100 } }\n    }\n  ) {\n    data {\n      searchSummary {\n        pagination { rightCursor }\n        data {\n          ... on MomentListings {\n            size\n            data {\n              ... on MomentListing {\n                id\n                flowRetailPrice { value }\n                moment {\n                  id tier playerName teamName setName season\n                  serialNumber circulationCount editionID\n                  storefrontListingID sellerAddress\n                  tags { id title }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}";

function parseListingPrice(listing: RawListing): number {
  if (listing.flowRetailPrice?.value) {
    return parseFloat(listing.flowRetailPrice.value) / 100_000_000;
  }
  return 0;
}

async function fetchADPage(
  cursor: string
): Promise<{ listings: RawListing[]; nextCursor: string | null }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(AD_GQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({ query: SEARCH_LISTINGS_QUERY }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok)
      throw new Error("GQL " + res.status + ": " + (await res.text()).slice(0, 200));
    const json = await res.json();
    if (json.errors?.length)
      throw new Error(
        json.errors.map((e: { message: string }) => e.message).join("; ")
      );
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
    console.log("[allday-sniper] AD page listings=" + listings.length);
    return { listings, nextCursor };
  } catch (err) {
    console.error(
      "[allday-sniper] AD page FAILED: " +
        (err instanceof Error ? err.message : String(err))
    );
    return { listings: [], nextCursor: null };
  }
}

async function fetchAllDayPool(): Promise<{
  listings: RawListing[];
  adCount: number;
}> {
  const [r1] = await Promise.allSettled([fetchADPage("")]);
  const all: RawListing[] = [];
  if (r1.status === "fulfilled") all.push(...r1.value.listings);
  console.log("[allday-sniper] AD pool: total=" + all.length);
  return { listings: all, adCount: all.length };
}

// ─── Flowty helpers ───────────────────────────────────────────────────────────

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
  nftView?: {
    serial?: number;
    traits?: Array<{ name: string; value: string }>;
  };
  valuations?: {
    blended?: { usdValue?: number };
    livetoken?: { usdValue?: number };
  };
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
  isLocked: boolean;
  paymentToken: "DUC" | "FUT" | "FLOW" | "USDC_E";
}

const FLOWTY_TRAIT_MAP: Record<string, string[]> = {
  setName: ["SetName", "setName", "Set Name", "set_name"],
  teamName: [
    "TeamName",
    "teamName",
    "Team Name",
    "TeamAtMoment",
    "teamAtMoment",
  ],
  tier: ["Tier", "tier", "MomentTier", "momentTier"],
  season: ["Season", "season", "SeasonNumber", "seasonNumber"],
  locked: ["Locked", "locked", "IsLocked", "isLocked"],
  fullName: [
    "FullName",
    "fullName",
    "Full Name",
    "PlayerName",
    "playerName",
  ],
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
        address: null,
        addresses: [],
        collectionFilters: [
          { collection: "0xe4cf4bdc1751c65d.AllDay", traits: [] },
        ],
        from,
        includeAllListings: true,
        limit: 24,
        onlyUnlisted: false,
        orderFilters: [
          { conditions: [], kind: "storefront", paymentTokens: [] },
        ],
        sort: {
          direction: "desc",
          listingKind: "storefront",
          path: "blockTimestamp",
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.error("[allday-sniper] Flowty HTTP " + res.status + " from=" + from);
      return [];
    }
    const json = await res.json();
    const rawItems: FlowtyNftItem[] = json?.nfts ?? json?.data ?? [];

    if (from === 0 && rawItems.length > 0) {
      const firstTraits = rawItems[0].nftView?.traits ?? [];
      console.log(
        "[allday-sniper] Flowty trait keys: " +
          firstTraits.map((t) => t.name).join(", ")
      );
    }

    console.log("[allday-sniper] Flowty from=" + from + ": rawItems=" + rawItems.length);
    const listings: FlowtyListing[] = [];
    for (const item of rawItems) {
      const order =
        item.orders?.find((o) => (o.salePrice ?? 0) > 0) ?? item.orders?.[0];
      if (!order?.listingResourceID) continue;
      if (order.salePrice <= 0) continue;
      const traits = item.nftView?.traits ?? [];
      const serial = item.card?.num ?? item.nftView?.serial ?? 0;
      const circ = item.card?.max ?? 0;
      const livetokenFmv =
        item.valuations?.blended?.usdValue ??
        item.valuations?.livetoken?.usdValue ??
        null;
      const paymentToken =
        VAULT_TO_PAYMENT_TOKEN[order.salePaymentVaultType ?? ""] ?? "DUC";

      listings.push({
        momentId: String(item.id),
        listingResourceID: order.listingResourceID,
        storefrontAddress:
          order.storefrontAddress ?? order.flowtyStorefrontAddress ?? "",
        price: order.salePrice,
        livetokenFmv: livetokenFmv && livetokenFmv > 0 ? livetokenFmv : null,
        blockTimestamp: order.blockTimestamp ?? 0,
        playerName:
          item.card?.title ??
          getTraitMulti(traits, FLOWTY_TRAIT_MAP.fullName) ??
          "",
        serial,
        circulationCount: circ,
        setName: getTraitMulti(traits, FLOWTY_TRAIT_MAP.setName),
        teamName: getTraitMulti(traits, FLOWTY_TRAIT_MAP.teamName),
        tier: (
          getTraitMulti(traits, FLOWTY_TRAIT_MAP.tier) || "COMMON"
        ).toUpperCase(),
        season: getTraitMulti(traits, FLOWTY_TRAIT_MAP.season),
        isLocked: getTraitMulti(traits, FLOWTY_TRAIT_MAP.locked) === "true",
        paymentToken,
      });
    }
    return listings;
  } catch (err) {
    console.error(
      "[allday-sniper] Flowty from=" + from + " FAILED: " +
        (err instanceof Error ? err.message : String(err))
    );
    return [];
  }
}

async function fetchAllFlowtyListings(): Promise<FlowtyListing[]> {
  const pages = await Promise.all([
    fetchFlowtyPage(0),
    fetchFlowtyPage(24),
    fetchFlowtyPage(48),
    fetchFlowtyPage(72),
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
    console.log(
      "[allday-sniper] Supabase editions: 0 hits for " +
        editionKeys.length +
        " keys"
    );
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
    .select(
      "edition_id, fmv_usd, wap_usd, floor_price_usd, confidence, days_since_sale, sales_count_30d, computed_at"
    )
    .in("edition_id", Array.from(extToUuid.values()))
    .order("computed_at", { ascending: false });

  if (!fmvRows?.length) {
    console.log(
      "[allday-sniper] Supabase FMV: 0 snapshots for " +
        editionRows.length +
        " editions"
    );
    return new Map();
  }

  const seen = new Set<string>();
  const map = new Map<string, FmvRow>();
  for (const row of fmvRows as {
    edition_id: string;
    fmv_usd: number;
    wap_usd: number | null;
    floor_price_usd: number | null;
    confidence: string;
    days_since_sale: number | null;
    sales_count_30d: number | null;
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
    });
  }

  console.log(
    "[allday-sniper] Supabase FMV hits: " + map.size + "/" + editionKeys.length
  );
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
  console.log("[allday-sniper] jersey_numbers: " + map.size + " players loaded");
  return map;
}

// ─── Input validation ─────────────────────────────────────────────────────────

const feedParamsSchema = z.object({
  minDiscount: z.coerce.number().min(0).max(100).default(0),
  tier: z.string().default("all"),
  player: z.string().default(""),
  team: z.string().default("all"),
  serial: z.string().default("all"),
  maxPrice: z.coerce.number().min(0).default(0),
  limit: z.coerce.number().min(1).max(500).default(0),
  sortBy: z
    .enum(["discount", "price_asc", "price_desc", "fmv_desc", "serial_asc"])
    .default("discount"),
});

// ─── Route handler ────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 25;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams);
  const params = feedParamsSchema.parse(raw);
  const { minDiscount, tier, team, sortBy, maxPrice, player, limit } = params;
  const serialFilter = params.serial;

  const cacheKey = "allday-sniper-feed:" + JSON.stringify(params);
  const CACHE_TTL = 25_000;

  let result = (await getOrSetCache(cacheKey, CACHE_TTL, async () => {
    return computeSniperFeed({
      minDiscount,
      tier,
      team,
      serialFilter,
      maxPrice,
      sortBy,
    });
  })) as {
    count: number;
    adCount: number;
    flowtyCount: number;
    lastRefreshed: string;
    deals: SniperDeal[];
  };

  // Post-fetch filter: player name
  if (player && player.trim()) {
    const playerLower = player.trim().toLowerCase();
    const filtered = result.deals.filter((d) =>
      d.playerName.toLowerCase().includes(playerLower)
    );
    result = { ...result, deals: filtered, count: filtered.length };
  }

  // Post-fetch limit
  if (limit > 0 && result.deals.length > limit) {
    result = { ...result, deals: result.deals.slice(0, limit), count: limit };
  }

  return NextResponse.json(result, {
    headers: {
      "Cache-Control":
        "public, max-age=0, s-maxage=25, stale-while-revalidate=60",
    },
  });
}

async function computeSniperFeed(opts: {
  minDiscount: number;
  tier: string;
  team: string;
  serialFilter: string;
  maxPrice: number;
  sortBy: string;
}) {
  const { minDiscount, tier, team, serialFilter, maxPrice, sortBy } = opts;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // 1. Fetch AD listings + Flowty in parallel
  const [{ listings: adListings, adCount }, flowtyListings] = await Promise.all(
    [fetchAllDayPool(), fetchAllFlowtyListings()]
  );

  console.log(
    "[allday-sniper] fetched ad=" +
      adListings.length +
      " flowty=" +
      flowtyListings.length
  );

  // 2. Build edition keys for Supabase FMV lookup
  const adEditionKeys = new Set<string>();
  for (const l of adListings) {
    const editionID = l.moment?.editionID;
    if (editionID) {
      adEditionKeys.add("allday:" + editionID);
    }
  }

  // 3. Collect unique player names for jersey lookups
  const allPlayerNames = Array.from(
    new Set([
      ...flowtyListings.map((l) => l.playerName).filter(Boolean),
      ...adListings.map((l) => l.moment?.playerName ?? "").filter(Boolean),
    ])
  );

  // 4. Supabase lookups in parallel
  const [fmvMap, jerseyMap] = await Promise.all([
    fetchFmvBatch(supabase, Array.from(adEditionKeys)),
    fetchJerseyNumbers(supabase, allPlayerNames),
  ]);

  // 5. Enrich AD listings
  const adDeals: SniperDeal[] = [];
  for (const l of adListings) {
    const askPrice = parseListingPrice(l);
    if (!askPrice || askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tierRaw = (l.moment?.tier ?? "COMMON").toUpperCase();
    if (tier !== "all" && tierRaw.toUpperCase() !== tier.toUpperCase()) continue;

    const editionID = l.moment?.editionID;
    if (!editionID) continue;
    const editionKey = "allday:" + editionID;

    const serial = l.moment?.serialNumber ?? 0;
    if (!serial) continue;
    const circ = l.moment?.circulationCount ?? 1000;

    const playerNameRaw = l.moment?.playerName ?? "Unknown";
    const jerseyNumber =
      jerseyMap.get(playerNameRaw.toLowerCase().trim()) ?? null;
    const {
      mult: sMult,
      signal: serialSignal,
      isSpecial: isSpecialSerial,
    } = serialMultiplier(serial, circ, jerseyNumber);
    const isJersey = jerseyNumber !== null && serial === jerseyNumber;

    const teamName = l.moment?.teamName ?? "";
    if (team !== "all" && teamName !== team) continue;

    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey" && !isJersey) continue;

    const fmvRow = fmvMap.get(editionKey) ?? null;
    if (!fmvRow) continue;

    const baseFmv = fmvRow.fmv;
    const confidence = fmvRow.confidence;
    const confidenceSource = "supabase";
    const adjustedFmv = baseFmv * sMult;
    const discount =
      askPrice >= adjustedFmv
        ? 0
        : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;
    if (discount < minDiscount) continue;

    adDeals.push({
      flowId: String(l.id),
      momentId: String(l.id),
      editionKey,
      playerName: playerNameRaw,
      teamName,
      setName: l.moment?.setName ?? "",
      season: l.moment?.season ?? "",
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
      serialMult: sMult,
      isSpecialSerial,
      isJersey,
      serialSignal,
      thumbnailUrl: buildThumbnailUrl(editionID),
      isLocked: false,
      updatedAt: new Date().toISOString(),
      buyUrl: "https://nflallday.com/listing/" + l.id,
      listingResourceID: l.moment?.storefrontListingID ?? null,
      storefrontAddress: l.moment?.sellerAddress ?? null,
      source: "allday",
      paymentToken: "DUC",
      offerAmount: null,
      offerFmvPct: null,
    });
  }

  // 6. Enrich Flowty listings
  const flowtyDeals: SniperDeal[] = [];
  let flowtyLivetokenHits = 0;
  let flowtySupabaseHits = 0;
  let flowtyAskFallbacks = 0;
  for (const item of flowtyListings) {
    const askPrice = item.price;
    if (askPrice <= 0) continue;
    if (maxPrice > 0 && askPrice > maxPrice) continue;

    const tierVal = item.tier ?? "COMMON";
    if (tier !== "all" && tierVal.toLowerCase() !== tier.toLowerCase()) continue;

    const teamName = item.teamName;
    if (team !== "all" && teamName !== team) continue;

    const serial = item.serial;
    const circ = item.circulationCount;
    const jerseyNumber =
      jerseyMap.get(item.playerName.toLowerCase().trim()) ?? null;
    const {
      mult: sMult,
      signal: serialSignal,
      isSpecial: isSpecialSerial,
    } = serialMultiplier(serial, circ > 0 ? circ : 99999, jerseyNumber);
    const isJersey = jerseyNumber !== null && serial === jerseyNumber;
    if (serialFilter === "special" && !isSpecialSerial) continue;
    if (serialFilter === "jersey" && !isJersey) continue;

    // FMV resolution: LiveToken -> Supabase -> ask-price fallback
    let baseFmv: number;
    let confidence: string;
    let confidenceSource: string;
    let editionKey = "";
    let fmvRow: FmvRow | null = null;

    if (item.livetokenFmv && item.livetokenFmv > 0) {
      baseFmv = item.livetokenFmv;
      confidence = "medium";
      confidenceSource = "livetoken";
      flowtyLivetokenHits++;
    } else {
      // Try Supabase FMV via editionKey overlap
      for (const key of adEditionKeys) {
        fmvRow = fmvMap.get(key) ?? null;
        if (fmvRow) break;
      }

      if (fmvRow && fmvRow.fmv > 0) {
        baseFmv = fmvRow.fmv;
        editionKey = fmvRow.editionKey;
        confidence = fmvRow.confidence;
        confidenceSource = "supabase";
        flowtySupabaseHits++;
      } else {
        baseFmv = askPrice;
        confidence = "low";
        confidenceSource = "ask_fallback";
        flowtyAskFallbacks++;
      }
    }

    const adjustedFmv = baseFmv * sMult;
    const discount =
      askPrice >= adjustedFmv
        ? 0
        : Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10;

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
      tier: tierVal,
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
      serialMult: sMult,
      isSpecialSerial,
      isJersey,
      serialSignal,
      thumbnailUrl: null,
      isLocked: item.isLocked,
      updatedAt: item.blockTimestamp
        ? new Date(item.blockTimestamp).toISOString()
        : new Date().toISOString(),
      buyUrl: "https://www.flowty.io/listing/" + item.listingResourceID,
      listingResourceID: item.listingResourceID,
      storefrontAddress: item.storefrontAddress,
      source: "flowty",
      paymentToken: item.paymentToken,
      offerAmount: null,
      offerFmvPct: null,
    });
  }

  console.log(
    "[allday-sniper] Flowty FMV sources: livetoken=" +
      flowtyLivetokenHits +
      " supabase=" +
      flowtySupabaseHits +
      " ask_fallback=" +
      flowtyAskFallbacks
  );

  // 7. Merge — Flowty wins on dedup by flowId
  const seen = new Set<string>();
  const allDeals: SniperDeal[] = [];
  for (const d of [...flowtyDeals, ...adDeals]) {
    if (!seen.has(d.flowId)) {
      seen.add(d.flowId);
      allDeals.push(d);
    }
  }

  // 8. Sort
  const sorted = allDeals.sort((a, b) => {
    if (sortBy === "price_asc") return a.askPrice - b.askPrice;
    if (sortBy === "price_desc") return b.askPrice - a.askPrice;
    if (sortBy === "fmv_desc") return b.adjustedFmv - a.adjustedFmv;
    if (sortBy === "serial_asc") return a.serial - b.serial;
    return b.discount - a.discount;
  });

  console.log(
    "[allday-sniper] DONE ad=" +
      adDeals.length +
      " flowty=" +
      flowtyDeals.length +
      " total=" +
      sorted.length +
      " fmv_hits=" +
      fmvMap.size
  );

  return {
    count: sorted.length,
    adCount: adDeals.length,
    flowtyCount: flowtyDeals.length,
    lastRefreshed: new Date().toISOString(),
    deals: sorted,
  };
}
