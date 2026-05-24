// app/api/sets/route.ts
// DB-driven Top Shot set tracker. Backed by:
//   - get_topshot_set_progress(wallet, collection_id)  → list view
//   - get_topshot_set_detail(wallet, set_id, collection_id) → single-set view
// Both RPCs run entirely against wallet_moments_cache + editions + fmv_snapshots
// in Postgres. No FCL, no Top Shot GraphQL.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveToFlowAddress } from "@/lib/flow-resolve";

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

type SetTier =
  | "complete"
  | "almost_there"
  | "bottleneck"
  | "completable"
  | "incomplete"
  | "unpriced";

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
  series: number | null;
  setTier: string | null;
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
  inProgressSets: number;
  notStartedSets: number;
  sets: SetProgress[];
  generatedAt: string;
}

interface RpcMissingPreview {
  playId: number | string;
  playerName: string | null;
  tier: string | null;
  fmvUsd: number | string | null;
  thumbnailUrl: string | null;
  topshotUrl: string | null;
}

interface RpcOwned {
  playId: number | string;
  playerName: string | null;
  tier: string | null;
  serialNumber: number | string | null;
  thumbnailUrl: string | null;
  topshotUrl: string | null;
}

interface RpcSetSummary {
  setId: string;
  setName: string;
  series: number | null;
  setTier: string | null;
  totalPlays: number;
  ownedPlays: number;
  missingPlays: number;
  completionPct: number | string | null;
  estimatedCostToComplete: number | string | null;
  missingPreview: RpcMissingPreview[];
}

interface RpcProgressPayload {
  wallet: string;
  totalSets: number;
  completeSets: number;
  inProgressSets: number;
  notStartedSets: number;
  generatedAt: string;
  sets: RpcSetSummary[];
}

interface RpcDetailPayload {
  setId: string;
  setName: string;
  series: number | null;
  setTier: string | null;
  wallet: string;
  totalPlays: number;
  ownedPlays: number;
  owned: RpcOwned[];
  missing: RpcMissingPreview[];
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function classifyTier(
  completionPct: number,
  missingPlays: number,
  estimatedCost: number
): SetTier {
  if (completionPct === 100) return "complete";
  if (missingPlays === 1 || missingPlays === 2) return "almost_there";
  if (estimatedCost > 0) return "completable";
  if (estimatedCost === 0 && missingPlays > 0) return "unpriced";
  return "incomplete";
}

function mapMissing(m: RpcMissingPreview): MissingPiece {
  return {
    playId: String(m.playId),
    playerName: m.playerName ?? "—",
    tier: m.tier ?? "COMMON",
    lowestAsk: toNum(m.fmvUsd),
    thumbnailUrl: m.thumbnailUrl ?? null,
    topshotUrl: m.topshotUrl ?? "",
  };
}

function mapOwned(o: RpcOwned): OwnedPiece {
  return {
    playId: String(o.playId),
    playerName: o.playerName ?? "—",
    tier: o.tier ?? "COMMON",
    serialNumber: toNum(o.serialNumber),
    thumbnailUrl: o.thumbnailUrl ?? null,
    topshotUrl: o.topshotUrl ?? "",
  };
}

function bottleneckOf(missing: MissingPiece[]): MissingPiece | null {
  let best: MissingPiece | null = null;
  for (const m of missing) {
    if (m.lowestAsk == null) continue;
    if (best === null || (m.lowestAsk ?? 0) > (best.lowestAsk ?? 0)) best = m;
  }
  return best;
}

function mapSetSummary(s: RpcSetSummary): SetProgress {
  const totalPlays = s.totalPlays ?? 0;
  const ownedPlays = s.ownedPlays ?? 0;
  const missingPlays = s.missingPlays ?? Math.max(totalPlays - ownedPlays, 0);
  const completionPct = Math.round(toNum(s.completionPct) ?? 0);
  const estimatedCost = toNum(s.estimatedCostToComplete) ?? 0;
  const missing = (s.missingPreview ?? []).map(mapMissing);
  const listedCount = missing.filter((m) => m.lowestAsk !== null).length;
  // Explicit min across the whole missing array — relying on `missing[0]` was an
  // implicit dependency on RPC ordering (Set audit B2).
  const lowestSingleAsk = missing
    .map((m) => m.lowestAsk)
    .filter((v): v is number => v !== null)
    .reduce<number | null>((min, v) => (min === null || v < min ? v : min), null);
  const bn = bottleneckOf(missing);
  return {
    setId: s.setId,
    setName: s.setName,
    series: s.series ?? null,
    setTier: s.setTier ?? null,
    totalEditions: totalPlays,
    ownedCount: ownedPlays,
    missingCount: missingPlays,
    listedCount,
    completionPct,
    totalMissingCost: estimatedCost,
    lowestSingleAsk,
    bottleneckPrice: bn?.lowestAsk ?? null,
    bottleneckPlayerName: bn?.playerName ?? null,
    tier: classifyTier(completionPct, missingPlays, estimatedCost),
    owned: [],
    missing,
    asksEnriched: true,
  };
}

function mapSetDetail(d: RpcDetailPayload): SetProgress {
  const totalPlays = d.totalPlays ?? 0;
  const ownedPlays = d.ownedPlays ?? 0;
  const missingPlays = Math.max(totalPlays - ownedPlays, 0);
  const completionPct = totalPlays > 0
    ? Math.round((ownedPlays / totalPlays) * 100)
    : 0;
  const owned = (d.owned ?? []).map(mapOwned);
  const missing = (d.missing ?? []).map(mapMissing);
  const listedCount = missing.filter((m) => m.lowestAsk !== null).length;
  const totalMissingCost = missing.reduce(
    (sum, m) => sum + (m.lowestAsk ?? 0),
    0
  );
  const lowestSingleAsk = missing
    .map((m) => m.lowestAsk)
    .filter((v): v is number => v !== null)
    .reduce<number | null>((min, v) => (min === null || v < min ? v : min), null);
  const bn = bottleneckOf(missing);
  return {
    setId: d.setId,
    setName: d.setName,
    series: d.series ?? null,
    setTier: d.setTier ?? null,
    totalEditions: totalPlays,
    ownedCount: ownedPlays,
    missingCount: missingPlays,
    listedCount,
    completionPct,
    totalMissingCost,
    lowestSingleAsk,
    bottleneckPrice: bn?.lowestAsk ?? null,
    bottleneckPlayerName: bn?.playerName ?? null,
    tier: classifyTier(completionPct, missingPlays, totalMissingCost),
    owned,
    missing,
    asksEnriched: true,
  };
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  const setFilter = req.nextUrl.searchParams.get("set");

  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 });
  }

  try {
    const flowAddress = await resolveToFlowAddress(wallet);

    if (setFilter) {
      const { data, error } = await (supabaseAdmin as any).rpc(
        "get_topshot_set_detail",
        {
          p_wallet: flowAddress,
          p_set_id: setFilter,
          p_collection_id: TOPSHOT_COLLECTION_ID,
        }
      );
      if (error) throw error;
      const payload = data as RpcDetailPayload | null;
      if (!payload || !payload.setId) {
        return NextResponse.json(
          {
            wallet,
            resolvedAddress: flowAddress,
            totalSets: 0,
            completeSets: 0,
            inProgressSets: 0,
            notStartedSets: 0,
            sets: [],
            generatedAt: new Date().toISOString(),
          } satisfies SetsResponse,
          { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } }
        );
      }
      const set = mapSetDetail(payload);
      return NextResponse.json(
        {
          wallet,
          resolvedAddress: flowAddress,
          totalSets: 1,
          completeSets: set.completionPct === 100 ? 1 : 0,
          inProgressSets: set.completionPct > 0 && set.completionPct < 100 ? 1 : 0,
          notStartedSets: set.ownedCount === 0 ? 1 : 0,
          sets: [set],
          generatedAt: new Date().toISOString(),
        } satisfies SetsResponse,
        { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } }
      );
    }

    const { data, error } = await (supabaseAdmin as any).rpc(
      "get_topshot_set_progress",
      {
        p_wallet: flowAddress,
        p_collection_id: TOPSHOT_COLLECTION_ID,
      }
    );
    if (error) throw error;
    const payload = data as RpcProgressPayload | null;
    const sets = (payload?.sets ?? []).map(mapSetSummary);

    return NextResponse.json(
      {
        wallet,
        resolvedAddress: flowAddress,
        totalSets: payload?.totalSets ?? sets.length,
        completeSets: payload?.completeSets ?? sets.filter((s) => s.completionPct === 100).length,
        inProgressSets: payload?.inProgressSets ?? sets.filter((s) => s.completionPct > 0 && s.completionPct < 100).length,
        notStartedSets: payload?.notStartedSets ?? sets.filter((s) => s.ownedCount === 0).length,
        sets,
        generatedAt: payload?.generatedAt ?? new Date().toISOString(),
      } satisfies SetsResponse,
      { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } }
    );
  } catch (err) {
    console.error("[/api/sets] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
