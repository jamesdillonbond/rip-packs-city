// app/api/ufc-set-progress/route.ts
//
// Thin wrapper around get_ufc_set_progress(wallet) SECDEF RPC.
// Returns the same shape as /api/sets so the existing sets page can render
// UFC Strike without UI changes.
//
// UFC's RPC does NOT return missingPreview today — UFC editions still have
// mostly empty thumbnail_url values until the edition resolver fills them.
// So the mapped missing[] will be empty. The sets list itself works fine.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type SetTier =
  | "complete"
  | "almost_there"
  | "bottleneck"
  | "completable"
  | "incomplete"
  | "unpriced";

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

function classifyTier(s: RpcSet): SetTier {
  if (s.completionPct >= 100) return "complete";
  if (s.completionPct === 0) return "incomplete";
  const cost = s.estimatedCostToComplete ?? null;
  const hasCost = cost !== null && cost > 0;
  if (s.missingPlays <= 3 && hasCost) return "almost_there";
  if (hasCost) return "completable";
  return "unpriced";
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 });
  }

  try {
    const { data, error } = await supabaseAdmin.rpc("get_ufc_set_progress", {
      p_wallet: wallet,
    });
    if (error) {
      console.log(`[ufc-set-progress] rpc error: ${error.message}`);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rpc = (data ?? {}) as RpcResponse;
    const rpcSets = Array.isArray(rpc.sets) ? rpc.sets : [];

    const sets: SetProgress[] = rpcSets.map((s) => {
      const missing: MissingPiece[] = (s.missingPreview ?? []).map((m, i) => ({
        playId: `${s.setId}:preview:${i}`,
        playerName: m.playerName ?? "—",
        tier: (m.tier ?? "CHALLENGER").toUpperCase(),
        lowestAsk: null,
        thumbnailUrl: m.thumbnailUrl ?? null,
        topshotUrl: `https://ufcstrike.com/search?query=${encodeURIComponent(m.playerName ?? "")}`,
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
    console.log(`[ufc-set-progress] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
