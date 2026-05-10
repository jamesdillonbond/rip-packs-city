// app/api/profile/tier-breakdown/route.ts
//
// GET /api/profile/tier-breakdown?ownerKey=xxx
// Aggregates wallet_moments_cache tier counts across every saved wallet for
// the owner. Uses the get_wallet_tier_counts RPC to bypass PostgREST's 1000
// row cap.
//
// Failure mode (2026-05-09 hardening): a saved-wallets fetch error or zero
// wallets returns the empty shape `{ tiers: [], total: 0 }` so the dashboard
// renders an empty state instead of a broken chart. We additionally surface
// `meta.coverage_zero = true` when every wallet returns zero tier counts —
// the consumer (TierBreakdownCard) can render an explanatory message rather
// than imply the user owns no moments at all.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const TIER_ORDER = ["Common", "Fandom", "Rare", "Legendary", "Ultimate"];

function emptyResponse(meta?: Record<string, unknown>) {
  return NextResponse.json({ tiers: [], total: 0, ...(meta ? { meta } : {}) });
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey");
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }

  try {
    const { data: wallets, error: walletsError } = await supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("owner_key", ownerKey);

    if (walletsError) {
      console.log(
        "[tier-breakdown] saved_wallets fetch failed:",
        walletsError.message,
        "code:",
        (walletsError as { code?: string }).code ?? "unknown"
      );
      return emptyResponse({ saved_wallets_unavailable: true });
    }

    const walletList = (wallets ?? []) as Array<{ wallet_addr: string }>;
    if (walletList.length === 0) {
      return emptyResponse({ no_wallets: true });
    }

    const aggregate: Record<string, number> = {};
    let total = 0;
    let walletsAttempted = 0;
    let walletsWithRpcError = 0;

    for (const w of walletList) {
      const addr = w.wallet_addr?.startsWith("0x")
        ? w.wallet_addr
        : "0x" + (w.wallet_addr ?? "");
      if (!addr || addr === "0x") continue;
      walletsAttempted += 1;

      const { data, error } = await (supabase as any).rpc("get_wallet_tier_counts", {
        p_wallet: addr,
      });
      if (error) {
        walletsWithRpcError += 1;
        console.log(
          "[tier-breakdown] get_wallet_tier_counts failed for",
          addr,
          "message:",
          error.message,
          "code:",
          error.code ?? "unknown"
        );
        continue;
      }
      const counts: Record<string, number> = data ?? {};
      for (const [tier, n] of Object.entries(counts)) {
        const num = Number(n) || 0;
        aggregate[tier] = (aggregate[tier] ?? 0) + num;
        total += num;
      }
    }

    if (total === 0 && walletsAttempted > 0) {
      // Every wallet returned zero counts — likely a wmc tier-coverage gap
      // for this owner's collections, not "user owns nothing." Flag for the
      // UI so it can render an explanatory empty state.
      return emptyResponse({
        coverage_zero: true,
        wallets_attempted: walletsAttempted,
        wallets_with_rpc_error: walletsWithRpcError,
      });
    }

    // Order by canonical tier order, then any unknown tiers
    const known = TIER_ORDER
      .filter(function (t) { return aggregate[t]; })
      .map(function (t) { return { tier: t, count: aggregate[t] }; });
    const extras = Object.entries(aggregate)
      .filter(function ([t]) { return !TIER_ORDER.includes(t); })
      .map(function ([t, n]) { return { tier: t, count: n }; });

    return NextResponse.json({ tiers: [...known, ...extras], total });
  } catch (err: any) {
    console.log(
      "[tier-breakdown] unexpected:",
      err?.message ?? String(err),
      "code:",
      err?.code ?? "unknown"
    );
    return emptyResponse({ unexpected_error: true });
  }
}
