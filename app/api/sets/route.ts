// app/api/sets/route.ts
// Sets completion tracker.
// v12: bottleneck detection, correct marketplace URLs, three-tier set classification

import { NextRequest, NextResponse } from "next/server";
import fcl from "@/lib/flow";
import * as t from "@onflow/types";
import { topshotGraphql } from "@/lib/topshot";

// ── In-memory resolve cache (5 min TTL) ───────────────────────────────────────

const resolveCache = new Map<string, { addr: string; expiresAt: number }>();
const RESOLVE_TTL_MS = 5 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────────

type SetTier =
  | "complete"
  | "almost_there"
  | "bottleneck"
  | "completable"
  | "incomplete"
  | "unpriced";

interface MomentMeta {
  momentId: string;
  playerName: string;
  setName: string;
  setId: string;
  playId: string;
  serial: number | null;
  tier: string;
  flowId: string | null;
  thumbnailUrl: string | null;
  lowestAsk: number | null;
}

interface OwnedPiece {
  playId: string;
  playerName: string;
  tier: string;
  serialNumber: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
}

interface MissingPiece {
  playId: string;
  playerName: string;
  tier: string;
  lowestAsk: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
}

interface SetProgress {
  setId: string;
  setName: string;
  totalEditions: number;
  ownedCount: number;
  missingCount: number;
  completionPct: number;
  totalMissingCost: number | null;
  lowestSingleAsk: number | null;
  bottleneckPrice: number | null;
  bottleneckPlayerName: string | null;
  tier: SetTier;
  owned: OwnedPiece[];
  missing: MissingPiece[];
  asksEnriched: boolean;
}

interface SetsResponse {
  wallet: string;
  resolvedAddress: string;
  totalSets: number;
  completeSets: number;
  sets: SetProgress[];
  generatedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isWalletAddress(v: string) {
  return /^0x[a-fA-F0-9]{16}$/.test(v.trim());
}

function ensureFlowPrefix(v: string) {
  return v.startsWith("0x") ? v : "0x" + v;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatTier(value: string | null): string {
  if (!value) return "COMMON";
  const n = value.toUpperCase();
  if (n.includes("LEGENDARY")) return "LEGENDARY";
  if (n.includes("RARE")) return "RARE";
  if (n.includes("ULTIMATE")) return "ULTIMATE";
  if (n.includes("FANDOM")) return "FANDOM";
  return "COMMON";
}

function buildThumbnailUrl(flowId: string | null) {
  if (!flowId) return null;
  return "https://assets.nbatopshot.com/media/" + flowId + "/image?width=180";
}

function buildMarketplaceUrl(setId: string, playId: string): string {
  return (
    "https://nbatopshot.com/search?edition_ids=" +
    setId +
    "_" +
    playId +
    "&search_input=&listing_types=FOR_SALE&sort_by=PRICE_ASC"
  );
}

// Detect the single most expensive missing piece when it's a clear outlier:
// ≥3x the median of the rest AND costs $10+ more
function detectBottleneck(missing: MissingPiece[]): MissingPiece | null {
  const priced = missing.filter((m) => m.lowestAsk !== null && m.lowestAsk > 0);
  if (priced.length < 2) return null;

  const sorted = [...priced].sort(
    (a, b) => (b.lowestAsk ?? 0) - (a.lowestAsk ?? 0)
  );
  const mostExpensive = sorted[0];
  const rest = sorted.slice(1);
  const medianRest =
    rest[Math.floor(rest.length / 2)].lowestAsk ?? 0;

  const price = mostExpensive.lowestAsk ?? 0;
  if (price >= 3 * medianRest && price - medianRest >= 10) {
    return mostExpensive;
  }
  return null;
}

// Classify a set — takes the full computed data, returns tier + bottleneck
function classifySet(
  missing: MissingPiece[],
  missingCount: number,
  completionPct: number,
  totalMissingCost: number | null,
  asksEnriched: boolean
): { tier: SetTier; bottleneck: MissingPiece | null } {
  if (completionPct === 100) return { tier: "complete", bottleneck: null };
  if (!asksEnriched) return { tier: "unpriced", bottleneck: null };

  const pricedCount = missing.filter((m) => m.lowestAsk !== null).length;
  const allPriced = pricedCount === missing.length && missing.length > 0;

  if (missingCount <= 3 && allPriced) {
    return { tier: "almost_there", bottleneck: detectBottleneck(missing) };
  }

  const bottleneck = detectBottleneck(missing);
  if (bottleneck) {
    return { tier: "bottleneck", bottleneck };
  }

  if (allPriced && totalMissingCost !== null) {
    return { tier: "completable", bottleneck: null };
  }

  return { tier: "incomplete", bottleneck: null };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, run)
  );
  return results;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Step 1: Resolve ────────────────────────────────────────────────────────────

type TopShotUserProfileResponse = {
  getUserProfileByUsername?: {
    publicInfo?: {
      flowAddress?: string | null;
      username?: string | null;
    } | null;
  } | null;
};

async function resolveToFlowAddress(input: string): Promise<string> {
  const trimmed = input.trim();
  if (isWalletAddress(trimmed)) return ensureFlowPrefix(trimmed);

  const cacheKey = trimmed.toLowerCase();
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log("[sets] resolve cache hit:", trimmed, "→", cached.addr);
    return cached.addr;
  }

  const cleanedUsername = trimmed.replace(/^@+/, "").trim();
  const query = `
    query ResolveUserByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress username }
      }
    }
  `;

  const tryResolve = async (username: string): Promise<string | null> => {
    try {
      const data = await topshotGraphql<TopShotUserProfileResponse>(query, {
        username,
      });
      const raw =
        data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null;
      return raw ? ensureFlowPrefix(raw) : null;
    } catch (e) {
      console.log(
        "[sets] resolve failed:",
        (e as Error).message?.slice(0, 100)
      );
      return null;
    }
  };

  let addr = await tryResolve(cleanedUsername);
  if (!addr && cleanedUsername.toLowerCase() !== cleanedUsername) {
    addr = await tryResolve(cleanedUsername.toLowerCase());
  }

  if (!addr) {
    throw new Error(
      'Could not resolve "' +
        trimmed +
        '" to a Flow address. Check the username and try again.'
    );
  }

  resolveCache.set(cacheKey, { addr, expiresAt: Date.now() + RESOLVE_TTL_MS });
  console.log("[sets] resolved", trimmed, "→", addr);
  return addr;
}

// ── Step 2: FCL — owned moment IDs ────────────────────────────────────────────

async function getOwnedMomentIds(wallet: string): Promise<number[]> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(address: Address): [UInt64] {
      let acct = getAccount(address)
      let col = acct.capabilities
        .borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
      if col == nil { return [] }
      return col!.getIDs()
    }
  `;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await fcl.query({
    cadence,
    args: (arg: any) => [arg(wallet, t.Address)],
  });
  return Array.isArray(result) ? (result as number[]) : [];
}

// ── Step 3: FCL — moment metadata ────────────────────────────────────────────

async function getMomentMetadata(
  wallet: string,
  id: number
): Promise<Record<string, string>> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    import MetadataViews from 0x1d7e57aa55817448
    access(all) fun main(address: Address, id: UInt64): {String:String} {
      let acct = getAccount(address)
      let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
        ?? panic("no collection")
      let nft = col.borrowMoment(id:id) ?? panic("no nft")
      let view = nft.resolveView(Type<TopShot.TopShotMomentMetadataView>()) ?? panic("no metadata")
      let data = view as! TopShot.TopShotMomentMetadataView
      return {
        "player":  data.fullName ?? "",
        "setName": data.setName ?? "",
        "serial":  data.serialNumber.toString(),
        "mint":    data.numMomentsInEdition?.toString() ?? "",
        "playID":  data.playID.toString(),
        "setID":   data.setID.toString()
      }
    }
  `;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await fcl.query({
    cadence,
    args: (arg: any) => [arg(wallet, t.Address), arg(String(id), t.UInt64)],
  });
  return result as Record<string, string>;
}

// ── Step 4: GQL getMintedMoment — tier + thumbnail ────────────────────────────

type MintedMomentGQL = {
  getMintedMoment?: {
    data?: {
      flowId?: string | null;
      tier?: string | null;
      forSale?: boolean | null;
      price?: string | number | null;
    } | null;
  } | null;
};

async function fetchMomentGQL(momentId: string) {
  const query = `
    query GetMoment($id: ID!) {
      getMintedMoment(momentId: $id) {
        data { flowId tier forSale price }
      }
    }
  `;
  try {
    const d = await topshotGraphql<MintedMomentGQL>(query, { id: momentId });
    const m = d?.getMintedMoment?.data;
    return {
      flowId: m?.flowId ?? null,
      tier: formatTier(m?.tier ?? null),
      lowestAsk: m?.forSale ? toNum(m?.price) : null,
    };
  } catch {
    return { flowId: null, tier: "COMMON", lowestAsk: null };
  }
}

// ── Step 5: FCL — all play IDs in a set ──────────────────────────────────────

async function getSetPlayIds(setId: number): Promise<number[]> {
  const cadence = `
    import TopShot from 0x0b2a3299cc857e29
    access(all) fun main(setID: UInt32): [UInt32] {
      return TopShot.getPlaysInSet(setID: setID) ?? []
    }
  `;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fcl.query({
      cadence,
      args: (arg: any) => [arg(String(setId), t.UInt32)],
    });
    return Array.isArray(result) ? (result as number[]) : [];
  } catch {
    return [];
  }
}

// ── Step 6: Lowest ask ────────────────────────────────────────────────────────

async function fetchLowestAskForPlay(
  setIntId: string,
  playIntId: string
): Promise<number | null> {
  const query = `
    query GetLowestAsk($setId: ID!, $playId: ID!) {
      searchMomentListings(input: {
        filters: { bySetID: [$setId] byPlayID: [$playId] byListingType: FOR_SALE }
        sortBy: PRICE_ASC
        first: 1
      }) {
        data {
          searchEdge {
            node { moment { listing { price } } }
          }
        }
      }
    }
  `;
  try {
    const data = await topshotGraphql<{
      searchMomentListings?: {
        data?: {
          searchEdge?: Array<{
            node?: { moment?: { listing?: { price?: number } } };
          }> | null;
        } | null;
      } | null;
    }>(query, { setId: setIntId, playId: playIntId });
    const edges = data?.searchMomentListings?.data?.searchEdge ?? [];
    const price = edges[0]?.node?.moment?.listing?.price;
    return typeof price === "number" ? price : null;
  } catch {
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  const setFilter = req.nextUrl.searchParams.get("set");
  const skipAsks = req.nextUrl.searchParams.get("skipAsks") === "1";
  const MAX_ASK_SETS = 15;
  const MAX_SETS_FULL = 30;

  if (!wallet) {
    return NextResponse.json(
      { error: "wallet param required" },
      { status: 400 }
    );
  }

  try {
    // 1. Resolve
    const flowAddress = await resolveToFlowAddress(wallet);
    console.log("[/api/sets] resolved", wallet, "→", flowAddress);

    // 2. Owned moment IDs
    const ids = await getOwnedMomentIds(flowAddress);
    console.log("[/api/sets] owned IDs:", ids.length);

    if (!ids.length) {
      return NextResponse.json({
        wallet,
        resolvedAddress: flowAddress,
        totalSets: 0,
        completeSets: 0,
        sets: [],
        generatedAt: new Date().toISOString(),
      } satisfies SetsResponse);
    }

    // 3. Fetch metadata (capped at 500)
    const slicedIds = ids.slice(0, 500);
    const moments = await mapWithConcurrency(slicedIds, 8, async (id) => {
      const [meta, gql] = await Promise.all([
        getMomentMetadata(flowAddress, id),
        fetchMomentGQL(String(id)),
      ]);
      return {
        momentId: String(id),
        playerName: meta.player ?? "Unknown",
        setName: meta.setName ?? "",
        setId: meta.setID ?? "",
        playId: meta.playID ?? "",
        serial: toNum(meta.serial),
        tier: gql.tier,
        flowId: gql.flowId,
        thumbnailUrl: buildThumbnailUrl(gql.flowId),
        lowestAsk: gql.lowestAsk,
      } as MomentMeta;
    });

    console.log("[/api/sets] metadata fetched for", moments.length);

    // 4. Group by setId + build global playId→playerName lookup
    const setMap = new Map<
      string,
      { setName: string; moments: MomentMeta[] }
    >();
    const globalPlayNames = new Map<string, string>();

    for (const m of moments) {
      if (!m.setId) continue;
      if (!setMap.has(m.setId))
        setMap.set(m.setId, { setName: m.setName, moments: [] });
      setMap.get(m.setId)!.moments.push(m);
      if (m.playId && m.playerName && m.playerName !== "Unknown") {
        globalPlayNames.set(m.playId, m.playerName);
      }
    }

    const setIds = (
      setFilter
        ? [setFilter].filter((id) => setMap.has(id))
        : Array.from(setMap.keys())
    ).sort((a, b) => {
      const countA = setMap.get(a)?.moments.length ?? 0;
      const countB = setMap.get(b)?.moments.length ?? 0;
      return countB - countA;
    });

    const setsToProcess = setFilter ? setIds : setIds.slice(0, MAX_SETS_FULL);
    console.log(
      "[/api/sets] processing",
      setsToProcess.length,
      "of",
      setIds.length,
      "sets"
    );

    // 5. First pass — FCL play roster per set (sequential)
    const rawProgress: Array<{
      setId: string;
      setName: string;
      allPlayIds: number[];
      owned: OwnedPiece[];
      missingPlayIds: number[];
    }> = [];

    for (const setId of setsToProcess) {
      const entry = setMap.get(setId)!;
      const setIntId = parseInt(setId, 10);
      if (isNaN(setIntId)) continue;

      if (rawProgress.length > 0) await sleep(50);

      const allPlayIds = await getSetPlayIds(setIntId);
      if (!allPlayIds.length) continue;

      const ownedByPlayId = new Map<string, MomentMeta[]>();
      for (const m of entry.moments) {
        if (!ownedByPlayId.has(m.playId)) ownedByPlayId.set(m.playId, []);
        ownedByPlayId.get(m.playId)!.push(m);
      }

      const owned: OwnedPiece[] = [];
      const missingPlayIds: number[] = [];

      for (const pid of allPlayIds) {
        const key = String(pid);
        if (ownedByPlayId.has(key)) {
          const copies = ownedByPlayId.get(key)!;
          const best = [...copies].sort(
            (a, b) => (a.serial ?? 99999) - (b.serial ?? 99999)
          )[0];
          owned.push({
            playId: key,
            playerName: best.playerName,
            tier: best.tier,
            serialNumber: best.serial,
            thumbnailUrl: best.thumbnailUrl,
            topshotUrl: best.flowId
              ? "https://nbatopshot.com/listings/moment/" + best.flowId
              : "https://nbatopshot.com/search?query=" +
                encodeURIComponent(best.playerName),
          });
        } else {
          missingPlayIds.push(pid);
        }
      }

      rawProgress.push({
        setId,
        setName: entry.setName,
        allPlayIds,
        owned,
        missingPlayIds,
      });
    }

    // Sort by completion % desc
    rawProgress.sort((a, b) => {
      const pctA =
        a.allPlayIds.length > 0 ? a.owned.length / a.allPlayIds.length : 0;
      const pctB =
        b.allPlayIds.length > 0 ? b.owned.length / b.allPlayIds.length : 0;
      return pctB - pctA;
    });

    // 6. Second pass — asks + classification
    const setProgressList: SetProgress[] = [];

    for (let idx = 0; idx < rawProgress.length; idx++) {
      const { setId, setName, allPlayIds, owned, missingPlayIds } =
        rawProgress[idx];

      const shouldFetchAsks: boolean =
        !skipAsks && (setFilter !== null || idx < MAX_ASK_SETS);

      const missingPieces: MissingPiece[] = await mapWithConcurrency(
        missingPlayIds,
        4,
        async (pid) => {
          const pidStr = String(pid);
          const playerName = globalPlayNames.get(pidStr) ?? "—";
          const lowestAsk = shouldFetchAsks
            ? await fetchLowestAskForPlay(setId, pidStr)
            : null;
          return {
            playId: pidStr,
            playerName,
            tier: "COMMON",
            lowestAsk,
            thumbnailUrl: null,
            topshotUrl: buildMarketplaceUrl(setId, pidStr),
          };
        }
      );

      missingPieces.sort((a, b) => {
        if (a.lowestAsk !== null && b.lowestAsk !== null)
          return a.lowestAsk - b.lowestAsk;
        if (a.lowestAsk !== null) return -1;
        if (b.lowestAsk !== null) return 1;
        return a.playerName.localeCompare(b.playerName);
      });

      const asksWithValues = missingPieces
        .map((mp) => mp.lowestAsk)
        .filter((v): v is number => v !== null);

      const totalMissingCost =
        asksWithValues.length === missingPieces.length &&
        missingPieces.length > 0
          ? asksWithValues.reduce((a, b) => a + b, 0)
          : null;

      const lowestSingleAsk =
        asksWithValues.length > 0 ? Math.min(...asksWithValues) : null;

      const completionPct =
        allPlayIds.length > 0
          ? Math.round((owned.length / allPlayIds.length) * 100)
          : 0;

      // Classify — pass computed values directly, no intermediate object
      const { tier, bottleneck } = classifySet(
        missingPieces,
        missingPieces.length,
        completionPct,
        totalMissingCost,
        shouldFetchAsks
      );

      // Build the full SetProgress object directly — no spread from partial type
      const entry: SetProgress = {
        setId,
        setName,
        totalEditions: allPlayIds.length,
        ownedCount: owned.length,
        missingCount: missingPieces.length,
        completionPct,
        totalMissingCost,
        lowestSingleAsk,
        bottleneckPrice: bottleneck?.lowestAsk ?? null,
        bottleneckPlayerName: bottleneck?.playerName ?? null,
        tier,
        owned,
        missing: missingPieces,
        asksEnriched: shouldFetchAsks,
      };

      setProgressList.push(entry);
    }

    // Final sort by tier then completion %
    const tierOrder: Record<SetTier, number> = {
      complete: 0,
      almost_there: 1,
      bottleneck: 2,
      completable: 3,
      incomplete: 4,
      unpriced: 5,
    };

    setProgressList.sort((a, b) => {
      const tA = tierOrder[a.tier];
      const tB = tierOrder[b.tier];
      if (tA !== tB) return tA - tB;
      return b.completionPct - a.completionPct;
    });

    console.log(
      "[/api/sets] done:",
      setProgressList.length,
      "sets |",
      setProgressList.filter((s) => s.tier === "complete").length,
      "complete |",
      setProgressList.filter((s) => s.tier === "almost_there").length,
      "almost there |",
      setProgressList.filter((s) => s.tier === "bottleneck").length,
      "with bottleneck"
    );

    return NextResponse.json(
      {
        wallet,
        resolvedAddress: flowAddress,
        totalSets: setProgressList.length,
        completeSets: setProgressList.filter((s) => s.tier === "complete")
          .length,
        sets: setProgressList,
        generatedAt: new Date().toISOString(),
      } satisfies SetsResponse,
      {
        headers: {
          "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
        },
      }
    );
  } catch (err) {
    console.error("[/api/sets] error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}