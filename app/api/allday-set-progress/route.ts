// app/api/allday-set-progress/route.ts
//
// Thin wrapper around get_allday_set_progress(wallet) SECDEF RPC.
// Returns the same shape as /api/sets so the existing sets page can
// render AllDay without UI changes.
//
// Differences vs. the older /api/allday-sets route:
//  - Pre-aggregated from Supabase (analytics_sales + editions); no Cadence
//    or GraphQL fan-out at request time.
//  - Returns missingPreview[] (top-5 by FMV) instead of the full per-piece
//    missing list with live asks.
//  - Owned[] is intentionally empty — the existing detail-modal callback
//    hardcodes /api/sets which only works for TopShot, so per-set deep
//    dives weren't functional for AllDay anyway.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { classifySetTier, type SetTier } from "@/lib/set-completion-tier";

interface MissingPiece {
  playId: string;
  playerName: string;
  tier: string;
  lowestAsk: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
  fmv: number | null;
}

interface OwnedPiece {
  playId: string;
  playerName: string;
  tier: string;
  serialNumber: number | null;
  thumbnailUrl: string | null;
  topshotUrl: string;
}

interface SetProgress {
  setId: string;
  setName: string;
  series?: number | null;
  setTier?: string | null;
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
  playerName?: string | null;
  tier?: string | null;
  fmvUsd?: number | null;
  thumbnailUrl?: string | null;
}

interface RpcSet {
  setId: string;
  setName: string;
  setTier?: string | null;
  ownedPlays: number;
  totalPlays: number;
  missingPlays: number;
  completionPct: number;
  estimatedCostToComplete?: number | null;
  missingPreview?: RpcMissingPreview[] | null;
}

interface RpcResponse {
  wallet?: string | null;
  resolvedAddress?: string | null;
  totalSets?: number | null;
  completeSets?: number | null;
  inProgressSets?: number | null;
  notStartedSets?: number | null;
  sets?: RpcSet[] | null;
  generatedAt?: string | null;
}

// Shares lib/set-completion-tier.ts. Behaviour is unchanged for this surface
// (it already used the <= 3 threshold that is now canonical).
function classifyTier(s: RpcSet): SetTier {
  return classifySetTier({
    completionPct: s.completionPct,
    missingCount: s.missingPlays,
    estimatedCost: s.estimatedCostToComplete ?? null,
  });
}

const ALLDAY_SEARCH = "https://nflallday.com/search?query=";
function alldaySearchUrl(playerName: string | null | undefined): string {
  return ALLDAY_SEARCH + encodeURIComponent(playerName ?? "");
}

// ── per-set detail (?set=<setId>) ────────────────────────────────────────────
// Full owned + missing edition lists for ONE set, so the sets-page detail
// modal / card-expand render real pieces for AllDay (parity with Top Shot's
// /api/sets?set=). Returns the same SetsResponse shape (sets:[oneSet]) the
// shared fetchSetDetail() consumer reads.
interface RpcDetailOwned {
  playId?: string | null;
  playerName?: string | null;
  tier?: string | null;
  serialNumber?: number | null;
  thumbnailUrl?: string | null;
}
interface RpcDetailMissing {
  playId?: string | null;
  playerName?: string | null;
  tier?: string | null;
  fmvUsd?: number | null;
  thumbnailUrl?: string | null;
}
interface RpcSetDetail extends RpcSet {
  owned?: RpcDetailOwned[] | null;
  missing?: RpcDetailMissing[] | null;
}

async function handleSetDetail(wallet: string, setId: string): Promise<NextResponse> {
  const { data, error } = await boundedRead(supabaseAdmin.rpc("get_allday_set_detail", {
    p_wallet: wallet,
    p_set_id: setId,
  }), "api/allday-set-progress/get_allday_set_detail");
  if (error) {
    console.log(`[allday-set-progress] detail rpc error: ${error.message}`);
    return apiErrorResponse(error, "api/allday-set-progress");
  }
  const d = data as RpcSetDetail | null;
  if (!d || !d.setId) {
    // Unknown set for this collection — empty, not an error.
    return NextResponse.json(
      { wallet, resolvedAddress: wallet, totalSets: 0, completeSets: 0, inProgressSets: 0, notStartedSets: 0, sets: [], generatedAt: new Date().toISOString() } satisfies SetsResponse,
      { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } },
    );
  }

  const owned: OwnedPiece[] = (d.owned ?? []).map((p) => ({
    playId: String(p.playId ?? ""),
    playerName: p.playerName ?? "—",
    tier: (p.tier ?? "COMMON").toUpperCase(),
    serialNumber: p.serialNumber ?? null,
    thumbnailUrl: p.thumbnailUrl ?? null,
    topshotUrl: alldaySearchUrl(p.playerName),
  }));
  const missing: MissingPiece[] = (d.missing ?? []).map((m) => ({
    playId: String(m.playId ?? ""),
    playerName: m.playerName ?? "—",
    tier: (m.tier ?? "COMMON").toUpperCase(),
    lowestAsk: null,
    thumbnailUrl: m.thumbnailUrl ?? null,
    topshotUrl: alldaySearchUrl(m.playerName),
    fmv: m.fmvUsd ?? null,
  }));

  const cost = d.estimatedCostToComplete ?? null;
  const set: SetProgress = {
    setId: d.setId,
    setName: d.setName,
    setTier: d.setTier ?? null,
    totalEditions: d.totalPlays,
    ownedCount: d.ownedPlays,
    missingCount: d.missingPlays,
    listedCount: 0,
    completionPct: Math.round(d.completionPct ?? 0),
    totalMissingCost: cost,
    lowestSingleAsk: null,
    bottleneckPrice: null,
    bottleneckPlayerName: null,
    tier: classifyTier(d),
    owned,
    missing,
    asksEnriched: false,
  };

  const out: SetsResponse = {
    wallet,
    resolvedAddress: wallet,
    totalSets: 1,
    completeSets: set.tier === "complete" ? 1 : 0,
    inProgressSets: set.ownedCount > 0 && set.completionPct < 100 ? 1 : 0,
    notStartedSets: set.ownedCount === 0 ? 1 : 0,
    sets: [set],
    generatedAt: new Date().toISOString(),
  };
  return NextResponse.json(out, {
    headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
  });
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 });
  }

  const setId = req.nextUrl.searchParams.get("set")?.trim();
  if (setId) {
    try {
      return await handleSetDetail(wallet, setId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[allday-set-progress] detail fatal: ${msg}`);
      return apiErrorResponse(err, "api/allday-set-progress");
    }
  }

  try {
    const { data, error } = await boundedRead(supabaseAdmin.rpc("get_allday_set_progress", {
      p_wallet: wallet,
    }), "api/allday-set-progress/get_allday_set_progress");
    if (error) {
      console.log(`[allday-set-progress] rpc error: ${error.message}`);
      return apiErrorResponse(error, "api/allday-set-progress");
    }

    const rpc = (data ?? {}) as RpcResponse;
    const rpcSets = Array.isArray(rpc.sets) ? rpc.sets : [];

    const sets: SetProgress[] = rpcSets.map((s) => {
      const missing: MissingPiece[] = (s.missingPreview ?? []).map((m, i) => ({
        playId: `${s.setId}:preview:${i}`,
        playerName: m.playerName ?? "—",
        tier: (m.tier ?? "COMMON").toUpperCase(),
        lowestAsk: null,
        thumbnailUrl: m.thumbnailUrl ?? null,
        topshotUrl: `https://nflallday.com/search?query=${encodeURIComponent(m.playerName ?? "")}`,
        fmv: m.fmvUsd ?? null,
      }));

      const tier = classifyTier(s);
      const cost = s.estimatedCostToComplete ?? null;

      return {
        setId: s.setId,
        setName: s.setName,
        setTier: s.setTier ?? null,
        totalEditions: s.totalPlays,
        ownedCount: s.ownedPlays,
        missingCount: s.missingPlays,
        listedCount: 0,
        completionPct: Math.round(s.completionPct ?? 0),
        totalMissingCost: cost,
        lowestSingleAsk: null,
        bottleneckPrice: null,
        bottleneckPlayerName: null,
        tier,
        owned: [],
        missing,
        asksEnriched: false,
      };
    });

    const completeSets = sets.filter((s) => s.tier === "complete").length;
    const inProgressSets = sets.filter((s) => s.ownedCount > 0 && s.completionPct < 100).length;
    const notStartedSets = sets.filter((s) => s.ownedCount === 0).length;

    const out: SetsResponse = {
      wallet: rpc.wallet ?? wallet,
      resolvedAddress: rpc.resolvedAddress ?? wallet,
      totalSets: sets.length,
      completeSets,
      inProgressSets,
      notStartedSets,
      sets,
      generatedAt: rpc.generatedAt ?? new Date().toISOString(),
    };

    return NextResponse.json(out, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[allday-set-progress] fatal: ${msg}`);
    return apiErrorResponse(err, "api/allday-set-progress");
  }
}
