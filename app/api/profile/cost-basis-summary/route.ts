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
// ⚠ FAILURE MODES USED TO RETURN THE EMPTY ZERO-VALUED SHAPE AT HTTP 200, AND
// ON THIS ROUTE THAT IS A FABRICATED FINANCIAL NUMBER ABOUT THE READER'S OWN
// MONEY. `EMPTY_PAYLOAD` is `totalSpent: 0, totalPurchases: 0, totalFmv: 0,
// netPL: 0` — so a failed read published "$0 spent, $0 P/L" to a collector with
// a real portfolio. `CostBasisCard` DOES have an errored state, and it was
// UNREACHABLE through this route: it sets it on `typeof d.totalSpent !== "number"`,
// and 0 is a number. The client was right and the route was lying to it.
//
// 🚨 The per-wallet leg was worse than a partial: `totalFmv` accumulates from
// `cached_fmv_usd` for EVERY wallet row BEFORE the cost-basis RPC, so a
// `continue` past an errored wallet dropped only the SPEND side. `netPL =
// totalFmv - totalSpent` was therefore biased in ONE direction — a timeout on
// one wallet showed the reader a FABRICATED PROFIT. (This file's own comment
// already records the mirror of that bug: "inflated spend/purchases ~4x (the
// fake -79% P/L)".)
//
// Now: a genuine READ FAILURE answers with `apiErrorResponse`, which the card
// already renders as its errored state. The genuinely-empty states —
// unauthenticated, no saved wallets — keep their honest 200 and meta hint.

import { NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { apiErrorResponse } from "@/lib/api-error";

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
      return apiErrorResponse(walletsError, "api/profile/cost-basis-summary");
    }

    const wallets = (walletsRaw ?? []) as SavedWallet[];
    if (wallets.length === 0) {
      return emptyResponse({ no_wallets: true });
    }

    let totalSpent = 0;
    let totalPurchases = 0;
    let totalFmv = 0;

    // get_user_saved_wallets returns one row per (wallet x published
    // collection). cached_fmv_usd is per-collection, so totalFmv MUST sum
    // every row. get_wallet_cost_basis is per-wallet, so it must be called
    // once per DISTINCT wallet — counting it per collection-row inflated
    // spend/purchases ~4x (the fake -79% P/L).
    const seenCb = new Set<string>();

    for (const w of wallets) {
      totalFmv += Number(w.cached_fmv_usd ?? 0) || 0;

      const raw = w.wallet_addr ?? "";
      const addr = raw.startsWith("0x") ? raw : raw ? "0x" + raw : "";
      if (!addr || addr === "0x") continue;
      if (seenCb.has(addr)) continue;
      seenCb.add(addr);

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
        // Was `continue`. See the header: skipping here drops this wallet's
        // SPEND while its FMV has already been added, so the published netPL
        // overstates profit rather than merely being incomplete. There is no
        // honest partial to publish — the two sides of the subtraction would
        // cover different wallet sets.
        return apiErrorResponse(cbError, "api/profile/cost-basis-summary");
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
    return apiErrorResponse(err, "api/profile/cost-basis-summary");
  }
}
