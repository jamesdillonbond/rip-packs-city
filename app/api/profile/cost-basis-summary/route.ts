// app/api/profile/cost-basis-summary/route.ts
//
// GET /api/profile/cost-basis-summary
// Aggregates cost basis (via get_wallet_cost_basis RPC) across every
// saved wallet of the current authenticated user, returning a single
// P/L summary.
//
// Uses the SECDEF helper get_user_saved_wallets(p_user_id) to read the
// wallet list — bypasses the JWT-forwarding gap that was making the
// post-R3 endpoints return empty.
//
// Failure modes return the empty zero-valued shape so the dashboard's
// CostBasisCard renders an empty state instead of 500ing.

import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

const EMPTY_PAYLOAD = {
  totalSpent: 0,
  totalPurchases: 0,
  totalFmv: 0,
  netPL: 0,
  plPercent: null,
};

interface SavedWallet {
  wallet_addr: string | null;
  username: string | null;
  collection_id: string | null;
  collection_slug: string | null;
  nickname: string | null;
  cached_fmv_usd: number | null;
}

function emptyResponse(meta?: Record<string, unknown>) {
  return NextResponse.json({ ...EMPTY_PAYLOAD, ...(meta ? { meta } : {}) });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return emptyResponse({ unauthenticated: true });
  }

  try {
    const { data: walletsRaw, error: walletsError } = await (supabase as any).rpc(
      "get_user_saved_wallets",
      { p_user_id: user.id }
    );

    if (walletsError) {
      console.log(
        "[cost-basis-summary] get_user_saved_wallets failed:",
        walletsError.message,
        "code:",
        (walletsError as { code?: string }).code ?? "unknown"
      );
      return emptyResponse({ saved_wallets_unavailable: true });
    }

    const wallets = (walletsRaw ?? []) as SavedWallet[];
    if (wallets.length === 0) {
      return emptyResponse({ no_wallets: true });
    }

    let totalSpent = 0;
    let totalPurchases = 0;
    let totalFmv = 0;

    for (const w of wallets) {
      totalFmv += Number(w.cached_fmv_usd ?? 0) || 0;

      const raw = w.wallet_addr ?? "";
      const addr = raw.startsWith("0x") ? raw : raw ? "0x" + raw : "";
      if (!addr || addr === "0x") continue;

      const { data: cb, error: cbError } = await (supabase as any).rpc(
        "get_wallet_cost_basis",
        { p_wallet: addr, p_collection_id: TOPSHOT_COLLECTION_ID }
      );

      if (cbError) {
        console.log(
          "[cost-basis-summary] get_wallet_cost_basis failed for",
          addr,
          "message:",
          cbError.message,
          "code:",
          cbError.code ?? "unknown"
        );
        continue;
      }

      const acquisitions: Array<{ buy_price: number | null }> = Array.isArray(cb) ? cb : [];
      for (const a of acquisitions) {
        const price = Number(a.buy_price ?? 0);
        if (price > 0) {
          totalSpent += price;
          totalPurchases += 1;
        }
      }
    }

    const netPL = totalFmv - totalSpent;
    const plPercent = totalSpent > 0 ? (netPL / totalSpent) * 100 : null;

    return NextResponse.json({
      totalSpent: Number(totalSpent.toFixed(2)),
      totalPurchases,
      totalFmv: Number(totalFmv.toFixed(2)),
      netPL: Number(netPL.toFixed(2)),
      plPercent: plPercent != null ? Number(plPercent.toFixed(2)) : null,
    });
  } catch (err: any) {
    console.log(
      "[cost-basis-summary] unexpected:",
      err?.message ?? String(err),
      "code:",
      err?.code ?? "unknown"
    );
    return emptyResponse({ unexpected_error: true });
  }
}
