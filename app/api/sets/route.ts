// app/api/sets/route.ts
// DB-driven Top Shot set tracker. Backed by:
//   - get_topshot_set_progress(wallet, collection_id)  → list view
//   - get_topshot_set_detail(wallet, set_id, collection_id) → single-set view
// Both RPCs run entirely against wallet_moments_cache + editions + fmv_snapshots
// in Postgres. No FCL, no Top Shot GraphQL.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { safeApiError, statusForSafeError } from "@/lib/api-error";
import { resolveToFlowAddress } from "@/lib/chains/flow/flow-resolve";
import { detectAddressChain, isSupportedAddress } from "@/lib/address";

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

import { classifySetTier, type SetTier } from "@/lib/set-completion-tier";

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
  // lowestAsk is the real current floor (badge_editions.low_ask); fmv is the
  // secondary "value" figure. `null` low ask = no live listing for that play.
  lowestAsk: number | null;
  fmv: number | null;
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
  /** Missing plays with neither an ask nor an FMV; null when the preview is not the whole missing set. */
  unpricedMissingCount?: number | null;
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
  lowAsk: number | string | null;
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

// Was: `missingPlays === 1 || === 2` - the odd one out of five surfaces.
// Now shares lib/set-completion-tier.ts (<= 3). See that file's product note.
function classifyTier(
  completionPct: number,
  missingPlays: number,
  estimatedCost: number | null
): SetTier {
  return classifySetTier({
    completionPct,
    missingCount: missingPlays,
    estimatedCost,
  });
}

function mapMissing(m: RpcMissingPreview): MissingPiece {
  return {
    playId: String(m.playId),
    playerName: m.playerName ?? "—",
    tier: m.tier ?? "COMMON",
    // Real current floor (what you'd pay to Quick-Buy now); FMV kept as the
    // secondary value figure. Falls back to FMV only when no live listing exists.
    lowestAsk: toNum(m.lowAsk) ?? toNum(m.fmvUsd),
    fmv: toNum(m.fmvUsd),
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
  const missing = (s.missingPreview ?? []).map(mapMissing);
  const listedCount = missing.filter((m) => m.lowestAsk !== null).length;
  // 2026-09-24 — an UNKNOWN cost is not a zero. The RPC's
  // estimated_cost_to_complete is COALESCE(SUM(COALESCE(low_ask, fmv)), 0), so a
  // set whose missing plays have neither an ask nor an FMV comes back as 0 and
  // the callout printed "Base Set — 1 away · $0.00" (live, Trevor's wallet).
  // The preview carries every missing play whenever missingPlays <= 5 (the
  // near-complete callout's whole population), so when it is complete and NO
  // missing play is priced, the cost is unknown → null. A partially priced set
  // keeps the sum (a lower bound) and reports how many plays are unpriced.
  const previewComplete = missing.length >= missingPlays;
  const unpricedMissingCount = previewComplete ? missing.filter((m) => m.lowestAsk === null).length : null;
  const rawCost = toNum(s.estimatedCostToComplete);
  const estimatedCost: number | null =
    rawCost === null ? null
    : previewComplete && unpricedMissingCount === missingPlays && missingPlays > 0 ? null
    : rawCost;
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
    unpricedMissingCount,
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
  // 2026-09-24 — same rule as mapSetSummary: no priced missing play → null,
  // never a summed-over-zeros "$0.00". Partially priced → lower bound + count.
  const unpricedMissingCount = missing.filter((m) => m.lowestAsk === null).length;
  const totalMissingCost: number | null =
    missing.length > 0 && unpricedMissingCount === missing.length
      ? null
      : missing.reduce((sum, m) => sum + (m.lowestAsk ?? 0), 0);
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

  // ⛔ 2026-09-19 — A NON-FLOW ADDRESS CAME BACK AS HTTP 500 "Failed to load
  // sets.", which is the wrong claim twice over. This tracker is TOP SHOT ONLY
  // by construction — it hardcodes TOPSHOT_COLLECTION_ID and calls
  // get_topshot_set_progress — so a Solana (Candy) or EVM address is not a
  // failure, it is a question this route cannot be asked. Measured live: a
  // base58 wallet returned `{"error":"Failed to load sets.","code":"internal",
  // "retryable":false}` at 500.
  //
  // MECHANISM: `resolveToFlowAddress` treats anything that is not a Flow
  // address as a USERNAME, so a base58 wallet went to the DECOMMISSIONED Top
  // Shot GraphQL host — twice, via the lower-cased retry — and then threw
  // 'Could not resolve "<address>" to a Flow address. Check the username and
  // try again.' The generic catch turned that into a 500. Two costs: the reader
  // is told we broke when we did not, and every such call burned two round
  // trips on a dead host and a `host-circuit` failure note with it.
  //
  // ⚠ SHAPE CHOSEN TO MATCH THE HOUSE PATTERN, not invented: `/api/wallet-cost-
  // basis` and `/api/wallet-hold-time` already answer 200 with a typed `reason`
  // (`cost_basis_unavailable`, `acquisition_data_unavailable`) when a feature
  // does not apply to the collection asked for. Not-applicable is not an error.
  //
  // ⛔ AND NO FABRICATED ZEROS: this branch returns `sets: []` and the reason,
  // and DELIBERATELY OMITS totalSets / completeSets / inProgressSets /
  // notStartedSets rather than sending 0s. A zero here would be a claim about
  // the wallet's set progress; absence is the truth. (Verified the only
  // consumer is safe either way: `nearCompleteSets()` returns [] for both null
  // and [], so the strip simply does not render.)
  //
  // ⚠ A USERNAME MUST NOT REACH THIS BRANCH — `isSupportedAddress` is false for
  // one, so username resolution is completely untouched. Narrowing it to
  // "recognised address on a chain that is not Cadence" is what keeps this from
  // turning an unresolved username into a confident empty answer.
  if (isSupportedAddress(wallet) && detectAddressChain(wallet) !== "cadence") {
    return NextResponse.json(
      {
        wallet,
        sets: [],
        reason: "set_tracking_unavailable",
        message:
          "Set tracking is a Top Shot feature and this is not a Flow address.",
      },
      { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } }
    );
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
    // Full detail stays in the server log — that is where it belongs.
    console.error("[/api/sets] error:", err);
    // ⚠ Do NOT return err.message. The sets page renders `body.error` verbatim
    // under an "ERROR" heading, so passing the driver message through put
    // "canceling statement due to statement timeout" in front of anonymous
    // visitors on the flagship Top Shot Set Tracker (deep-audit D3). An earlier
    // fix here replaced "[object Object]" with the real message; the real
    // message was the problem. Classify instead.
    const safe = safeApiError(err, "Failed to load sets.");
    return NextResponse.json(safe, {
      status: statusForSafeError(safe),
      headers: safe.retryable ? { "Retry-After": "60" } : undefined,
    });
  }
}
