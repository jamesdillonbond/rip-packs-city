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
import { resolveSetProgressWallet, notScannedResponse } from "@/lib/sets/set-progress-wallet";
import { supabaseAdmin } from "@/lib/supabase";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { isAptosAccountAddress, UFC_APTOS_NOT_INDEXED_COPY } from "@/lib/ufc-aptos";

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

export async function GET(req: NextRequest) {
  const input = req.nextUrl.searchParams.get("wallet")?.trim();
  if (!input) {
    return NextResponse.json({ error: "wallet param required" }, { status: 400 });
  }

  try {
    // 2026-11-14: a username / un-prefixed address used to reach the RPC raw and
    // match nothing — "0% of every set". See lib/sets/set-progress-wallet.ts.
    // 2026-11-26: UFC Strike lives on Flow and Aptos. An Aptos account address is taken as
    // itself (get_ufc_set_progress counts ufc_aptos_holdings for it); the Flow gate would
    // read it as a username and answer "couldn't find a Flow wallet".
    const aptos = isAptosAccountAddress(input);
    let wallet: string;
    if (aptos) {
      wallet = input.toLowerCase();
    } else {
      const gate = await resolveSetProgressWallet(input);
      if (!gate.ok) return gate.response;
      wallet = gate.wallet;
    }
    const { data, error } = await boundedRead(supabaseAdmin.rpc("get_ufc_set_progress", {
      p_wallet: wallet,
    }), "api/ufc-set-progress/get_ufc_set_progress");
    if (error) {
      console.log(`[ufc-set-progress] rpc error: ${error.message}`);
      return apiErrorResponse(error, "api/ufc-set-progress");
    }

    const rpc = (data ?? {}) as RpcResponse;
    const rpcSets = Array.isArray(rpc.sets) ? rpc.sets : [];
    // 2026-11-14: owning NOTHING has two meanings — an indexed wallet with no
    // pieces here (0% is true) or a wallet RPC never walked (0% is a claim).
    if (!rpcSets.some((s) => (s.ownedPlays ?? 0) > 0)) {
      // RPC indexes Aptos holdings only for wallets it has walked, so owning nothing on an
      // Aptos address is not evidence of an empty wallet: say so, never "0% of every set".
      if (aptos) {
        return NextResponse.json(
          { error: UFC_APTOS_NOT_INDEXED_COPY, code: "wallet_not_indexed", retryable: false },
          { status: 409 },
        );
      }
      const notScanned = await notScannedResponse(wallet);
      if (notScanned) return notScanned;
    }

    const sets: SetProgress[] = rpcSets.map((s) => {
      const missing: MissingPiece[] = (s.missingPreview ?? []).map((m, i) => ({
        playId: `${s.setId}:preview:${i}`,
        playerName: m.playerName ?? "—",
        tier: (m.tier ?? "FANDOM").toUpperCase(),
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
    return apiErrorResponse(err, "api/ufc-set-progress");
  }
}
