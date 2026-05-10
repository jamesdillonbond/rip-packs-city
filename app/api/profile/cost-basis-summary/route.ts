// app/api/profile/cost-basis-summary/route.ts
//
// GET /api/profile/cost-basis-summary?ownerKey=xxx
// Aggregates cost basis (via get_wallet_cost_basis RPC) across every saved
// wallet for the owner, returning a single P/L summary.
//
// Failure mode (2026-05-09 hardening): a saved_wallets fetch error or zero
// wallets returns a zero-valued shape so the dashboard's CostBasisCard
// renders an empty state instead of 500ing.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

const EMPTY_PAYLOAD = {
  totalSpent: 0,
  totalPurchases: 0,
  totalFmv: 0,
  netPL: 0,
  plPercent: null,
};

function emptyResponse(meta?: Record<string, unknown>) {
  return NextResponse.json({ ...EMPTY_PAYLOAD, ...(meta ? { meta } : {}) });
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }

  try {
    const { data: wallets, error: walletsError } = await supabase
      .from("saved_wallets")
      .select("wallet_addr, cached_fmv_usd")
      .eq("owner_key", ownerKey);

    if (walletsError) {
      console.log(
        "[cost-basis-summary] saved_wallets fetch failed:",
        walletsError.message,
        "code:",
        (walletsError as { code?: string }).code ?? "unknown"
      );
      return emptyResponse({ saved_wallets_unavailable: true });
    }

    if (!wallets || wallets.length === 0) {
      return emptyResponse({ no_wallets: true });
    }

    let totalSpent = 0;
    let totalPurchases = 0;
    let totalFmv = 0;

    for (const w of wallets as Array<{ wallet_addr: string; cached_fmv_usd: number | null }>) {
      totalFmv += Number(w.cached_fmv_usd ?? 0) || 0;

      const addr = w.wallet_addr?.startsWith("0x")
        ? w.wallet_addr
        : "0x" + (w.wallet_addr ?? "");
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
