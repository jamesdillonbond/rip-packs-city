// app/api/allday-sets/route.ts
// NFL All Day parallel of /api/sets — uses AllDay contract, alldayGraphql,
// and AllDay Cadence scripts instead of TopShot equivalents.

import { NextRequest, NextResponse } from "next/server";
import fcl from "@/lib/flow";
import * as t from "@onflow/types";
import { alldayGraphql } from "@/lib/allday";
import {
  GET_OWNED_MOMENT_IDS,
  GET_MOMENT_METADATA,
  GET_EDITIONS_IN_SET,
  GET_EDITION_DATA,
  GET_PLAY_DATA,
} from "@/lib/allday-cadence";

// ── Cache ─────────────────────────────────────────────────────────────────────

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
  listedCount: number;
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
  if (n.includes("RARE") || n.includes("PREMIUM")) return "RARE";
  if (n.includes("ULTIMATE")) return "ULTIMATE";
  return "COMMON";
}

function alldayImageUrl(flowId: string | null) {
  if (!flowId) return null;
  return "https://assets.nflallday.com/media/" + flowId + "/image?width=180";
}

function alldayEditionKey(setId: string, playId: string): string {
  return setId + ":" + playId;
}

function buildMarketplaceUrl(setId: string, playId: string): string {
  return (
    "https://nflallday.com/search?edition_ids=" +
    alldayEditionKey(setId, playId) +
    "&listing_types=FOR_SALE&sort_by=PRICE_ASC"
  );
}

function detectBottleneck(missing: MissingPiece[]): MissingPiece | null {
  const priced = missing.filter((m) => m.lowestAsk !== null && m.lowestAsk > 0);
  if (priced.length < 2) return null;
  const sorted = [...priced].sort((a, b) => (b.lowestAsk ?? 0) - (a.lowestAsk ?? 0));
  const mostExpensive = sorted[0];
  const rest = sorted.slice(1);
  const medianRest = rest[Math.floor(rest.length / 2)].lowestAsk ?? 0;
  const price = mostExpensive.lowestAsk ?? 0;
  if (price >= 3 * medianRest && price - medianRest >= 10) return mostExpensive;
  return null;
}

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
  if (bottleneck) return { tier: "bottleneck", bottleneck };
  if (allPriced && totalMissingCost !== null) return { tier: "completable", bottleneck: null };
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ── Resolve ────────────────────────────────────────────────────────────────────

type UserProfileResponse = {
  getUserProfileByUsername?: {
    publicInfo?: { flowAddress?: string | null; username?: string | null } | null;
  } | null;
};

async function resolveToFlowAddress(input: string): Promise<string> {
  const trimmed = input.trim();
  if (isWalletAddress(trimmed)) return ensureFlowPrefix(trimmed);
  const cacheKey = trimmed.toLowerCase();
  const cached = resolveCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.addr;

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
      const data = await alldayGraphql<UserProfileResponse>(query, { username });
      const raw = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null;
      return raw ? ensureFlowPrefix(raw) : null;
    } catch { return null; }
  };

  let addr = await tryResolve(cleanedUsername);
  if (!addr && cleanedUsername.toLowerCase() !== cleanedUsername) {
    addr = await tryResolve(cleanedUsername.toLowerCase());
  }
  if (!addr) throw new Error('Could not resolve "' + trimmed + '" to a Flow address. Check the username and try again.');
  resolveCache.set(cacheKey, { addr, expiresAt: Date.now() + RESOLVE_TTL_MS });
  return addr;
}

// ── FCL — owned moment IDs ────────────────────────────────────────────────────

async function getOwnedMomentIds(wallet: string): Promise<number[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await fcl.query({ cadence: GET_OWNED_MOMENT_IDS, args: (arg: any) => [arg(wallet, t.Address)] });
  return Array.isArray(result) ? (result as number[]) : [];
}

// ── FCL — moment metadata ─────────────────────────────────────────────────────

async function getMomentMetadata(wallet: string, id: number): Promise<Record<string, string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await fcl.query({ cadence: GET_MOMENT_METADATA, args: (arg: any) => [arg(wallet, t.Address), arg(String(id), t.UInt64)] });
  return result as Record<string, string>;
}

// ── GQL getMintedMoment ───────────────────────────────────────────────────────

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
    const d = await alldayGraphql<MintedMomentGQL>(query, { id: momentId });
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

// ── FCL — all edition IDs in a set ───────────────────────────────────────────

async function getEditionIdsInSet(setId: number): Promise<number[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fcl.query({ cadence: GET_EDITIONS_IN_SET, args: (arg: any) => [arg(String(setId), t.UInt64)] });
    return Array.isArray(result) ? (result as number[]) : [];
  } catch { return []; }
}

// ── FCL — edition data (playID from editionID) ──────────────────────────────

async function getEditionData(editionId: number): Promise<{ playId: string; tier: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fcl.query({ cadence: GET_EDITION_DATA, args: (arg: any) => [arg(String(editionId), t.UInt64)] });
    const data = result as Record<string, string>;
    return { playId: data?.playID ?? "", tier: formatTier(data?.tier ?? null) };
  } catch {
    return { playId: "", tier: "COMMON" };
  }
}

// ── FCL — play metadata for missing plays ───────────────────────────────────

async function getPlayMetadata(playId: number): Promise<{ playerName: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fcl.query({ cadence: GET_PLAY_DATA, args: (arg: any) => [arg(String(playId), t.UInt64)] });
    const meta = result as Record<string, string>;
    return { playerName: meta?.playerFullName ?? meta?.PlayerFullName ?? "Unknown" };
  } catch {
    return { playerName: "Unknown" };
  }
}

// ── Lowest ask via GQL ──────────────────────────────────────────────────────

async function fetchLowestAskForPlay(setIntId: string, playIntId: string): Promise<number | null> {
  const query = `
    query GetLowestAsk($setId: ID!, $playId: ID!) {
      searchMomentListings(input: {
        filters: { bySetID: [$setId] byPlayID: [$playId] byListingType: FOR_SALE }
        sortBy: PRICE_ASC
        first: 1
      }) {
        data {
          searchEdge { node { moment { listing { price } } } }
        }
      }
    }
  `;
  try {
    const data = await alldayGraphql<{
      searchMomentListings?: {
        data?: {
          searchEdge?: Array<{ node?: { moment?: { listing?: { price?: number } } } }> | null;
        } | null;
      } | null;
    }>(query, { setId: setIntId, playId: playIntId });
    const edges = data?.searchMomentListings?.data?.searchEdge ?? [];
    const price = edges[0]?.node?.moment?.listing?.price;
    return typeof price === "number" ? price : null;
  } catch { return null; }
}

// ── Enrich missing plays with tier + thumbnail via GQL ────────────────────────

async function enrichMissingPlaysWithGQL(
  missing: MissingPiece[],
  setIntId: string
): Promise<MissingPiece[]> {
  const toEnrich = missing.slice(0, 20);

  const enriched = await mapWithConcurrency(toEnrich, 3, async (piece) => {
    try {
      const listingQuery = `
        query GetSampleMoment($setId: ID!, $playId: ID!) {
          searchMomentListings(input: {
            filters: { bySetID: [$setId] byPlayID: [$playId] byListingType: FOR_SALE }
            sortBy: PRICE_ASC
            first: 1
          }) {
            data {
              searchEdge { node { moment { id tier } } }
            }
          }
        }
      `;
      const data = await alldayGraphql<{
        searchMomentListings?: {
          data?: {
            searchEdge?: Array<{
              node?: { moment?: { id?: string; tier?: string } };
            }> | null;
          } | null;
        } | null;
      }>(listingQuery, { setId: setIntId, playId: piece.playId });

      const edge = data?.searchMomentListings?.data?.searchEdge?.[0];
      const momentId = edge?.node?.moment?.id;
      const tierFromListing = edge?.node?.moment?.tier;

      if (!momentId) return piece;

      const gql = await fetchMomentGQL(momentId);

      return {
        ...piece,
        tier: tierFromListing ? formatTier(tierFromListing) : gql.tier,
        thumbnailUrl: gql.flowId ? alldayImageUrl(gql.flowId) : null,
      };
    } catch {
      return piece;
    }
  });

  return [...enriched, ...missing.slice(20)];
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  const setFilter = req.nextUrl.searchParams.get("set");
  const skipAsks = req.nextUrl.searchParams.get("skipAsks") === "1";
  const MAX_ASK_SETS = 15;
  const MAX_SETS_FULL = 30;
  const isSingleSet = setFilter !== null;

  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 });
  }

  try {
    const flowAddress = await resolveToFlowAddress(wallet);
    console.log("[/api/allday-sets] resolved", wallet, "→", flowAddress);

    const ids = await getOwnedMomentIds(flowAddress);
    console.log("[/api/allday-sets] owned IDs:", ids.length);

    if (!ids.length) {
      return NextResponse.json({
        wallet, resolvedAddress: flowAddress,
        totalSets: 0, completeSets: 0, sets: [],
        generatedAt: new Date().toISOString(),
      } satisfies SetsResponse);
    }

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
        thumbnailUrl: alldayImageUrl(gql.flowId),
        lowestAsk: gql.lowestAsk,
      } as MomentMeta;
    });

    const setMap = new Map<string, { setName: string; moments: MomentMeta[] }>();
    const globalPlayNames = new Map<string, string>();

    for (const m of moments) {
      if (!m.setId) continue;
      if (!setMap.has(m.setId)) setMap.set(m.setId, { setName: m.setName, moments: [] });
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

    const rawProgress: Array<{
      setId: string;
      setName: string;
      allPlayIds: string[];
      owned: OwnedPiece[];
      missingPlayIds: string[];
    }> = [];

    for (const setId of setsToProcess) {
      const entry = setMap.get(setId)!;
      const setIntId = parseInt(setId, 10);
      if (isNaN(setIntId)) continue;
      if (rawProgress.length > 0) await sleep(50);

      // AllDay: get edition IDs in set, then resolve each to a play ID
      const editionIds = await getEditionIdsInSet(setIntId);
      if (!editionIds.length) continue;

      // Resolve edition → playId mapping
      const editionPlayMap = await mapWithConcurrency(editionIds, 4, async (edId) => {
        const data = await getEditionData(edId);
        return { editionId: edId, playId: data.playId, tier: data.tier };
      });

      // Deduplicate by playId (a set may have multiple editions of the same play)
      const playIdSet = new Set<string>();
      const allPlayIds: string[] = [];
      for (const ep of editionPlayMap) {
        if (ep.playId && !playIdSet.has(ep.playId)) {
          playIdSet.add(ep.playId);
          allPlayIds.push(ep.playId);
        }
      }
      if (!allPlayIds.length) continue;

      const ownedByPlayId = new Map<string, MomentMeta[]>();
      for (const m of entry.moments) {
        if (!ownedByPlayId.has(m.playId)) ownedByPlayId.set(m.playId, []);
        ownedByPlayId.get(m.playId)!.push(m);
      }

      const owned: OwnedPiece[] = [];
      const missingPlayIds: string[] = [];

      for (const pid of allPlayIds) {
        if (ownedByPlayId.has(pid)) {
          const copies = ownedByPlayId.get(pid)!;
          const best = [...copies].sort((a, b) => (a.serial ?? 99999) - (b.serial ?? 99999))[0];
          owned.push({
            playId: pid,
            playerName: best.playerName,
            tier: best.tier,
            serialNumber: best.serial,
            thumbnailUrl: best.thumbnailUrl,
            topshotUrl: best.flowId
              ? "https://nflallday.com/listing/moment/" + best.flowId
              : "https://nflallday.com/search?query=" + encodeURIComponent(best.playerName),
          });
        } else {
          missingPlayIds.push(pid);
        }
      }

      rawProgress.push({ setId, setName: entry.setName, allPlayIds, owned, missingPlayIds });
    }

    rawProgress.sort((a, b) => {
      const pctA = a.allPlayIds.length > 0 ? a.owned.length / a.allPlayIds.length : 0;
      const pctB = b.allPlayIds.length > 0 ? b.owned.length / b.allPlayIds.length : 0;
      return pctB - pctA;
    });

    const setProgressList: SetProgress[] = [];

    for (let idx = 0; idx < rawProgress.length; idx++) {
      const { setId, setName, allPlayIds, owned, missingPlayIds } = rawProgress[idx];
      const shouldFetchAsks: boolean = !skipAsks && (isSingleSet || idx < MAX_ASK_SETS);

      const missingPieces: MissingPiece[] = await mapWithConcurrency(
        missingPlayIds,
        isSingleSet ? 3 : 4,
        async (pid) => {
          let playerName = globalPlayNames.get(pid) ?? "—";
          if (playerName === "—" && isSingleSet) {
            const pidNum = parseInt(pid, 10);
            if (!isNaN(pidNum)) {
              const meta = await getPlayMetadata(pidNum);
              playerName = meta.playerName;
              if (playerName !== "Unknown") globalPlayNames.set(pid, playerName);
            }
          }
          const lowestAsk = shouldFetchAsks
            ? await fetchLowestAskForPlay(setId, pid)
            : null;
          return {
            playId: pid,
            playerName,
            tier: "COMMON",
            lowestAsk,
            thumbnailUrl: null,
            topshotUrl: buildMarketplaceUrl(setId, pid),
          };
        }
      );

      missingPieces.sort((a, b) => {
        if (a.lowestAsk !== null && b.lowestAsk !== null) return a.lowestAsk - b.lowestAsk;
        if (a.lowestAsk !== null) return -1;
        if (b.lowestAsk !== null) return 1;
        return a.playerName.localeCompare(b.playerName);
      });

      let enrichedMissing = missingPieces;
      if (isSingleSet && shouldFetchAsks && missingPieces.length > 0) {
        enrichedMissing = await enrichMissingPlaysWithGQL(missingPieces, setId);
      }

      const asksWithValues = enrichedMissing
        .map((mp) => mp.lowestAsk)
        .filter((v): v is number => v !== null);

      const listedCount = asksWithValues.length;

      const totalMissingCost =
        listedCount === enrichedMissing.length && enrichedMissing.length > 0
          ? asksWithValues.reduce((a, b) => a + b, 0)
          : null;

      const lowestSingleAsk = asksWithValues.length > 0 ? Math.min(...asksWithValues) : null;
      const completionPct = allPlayIds.length > 0
        ? Math.round((owned.length / allPlayIds.length) * 100)
        : 0;

      const { tier, bottleneck } = classifySet(
        enrichedMissing, enrichedMissing.length, completionPct, totalMissingCost, shouldFetchAsks
      );

      const entry: SetProgress = {
        setId, setName,
        totalEditions: allPlayIds.length,
        ownedCount: owned.length,
        missingCount: enrichedMissing.length,
        listedCount,
        completionPct,
        totalMissingCost,
        lowestSingleAsk,
        bottleneckPrice: bottleneck?.lowestAsk ?? null,
        bottleneckPlayerName: bottleneck?.playerName ?? null,
        tier,
        owned,
        missing: enrichedMissing,
        asksEnriched: shouldFetchAsks,
      };

      setProgressList.push(entry);
    }

    const tierOrder: Record<SetTier, number> = {
      complete: 0, almost_there: 1, bottleneck: 2,
      completable: 3, incomplete: 4, unpriced: 5,
    };

    setProgressList.sort((a, b) => {
      const tA = tierOrder[a.tier];
      const tB = tierOrder[b.tier];
      if (tA !== tB) return tA - tB;
      return b.completionPct - a.completionPct;
    });

    return NextResponse.json(
      {
        wallet, resolvedAddress: flowAddress,
        totalSets: setProgressList.length,
        completeSets: setProgressList.filter((s) => s.tier === "complete").length,
        sets: setProgressList,
        generatedAt: new Date().toISOString(),
      } satisfies SetsResponse,
      { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } }
    );
  } catch (err) {
    console.error("[/api/allday-sets] error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
