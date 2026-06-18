// app/api/profile/top-movers/route.ts
//
// GET /api/profile/top-movers?days=7
// For every saved wallet of the current authenticated user, calls the
// get_top_movers RPC and merges the gainers/losers across wallets,
// returning the top 5 of each by absolute dollar change.
//
// Uses the SECDEF helper get_user_saved_wallets(p_user_id) to read the
// wallet list — service-role client bypasses the JWT-forwarding gap that
// was making the post-R3 endpoints return empty even when wallets exist.
//
// Failure modes mirror tier-breakdown: unauthenticated /
// saved_wallets_unavailable / no_wallets / unexpected_error all return
// the empty shape { gainers: [], losers: [] } so the dashboard renders
// an empty state instead of breaking.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

interface Mover {
  edition_id: string;
  player_name: string | null;
  set_name: string | null;
  current_fmv: number | null;
  past_fmv: number | null;
  delta: number;
  pct_change: number | null;
}

interface SavedWallet {
  wallet_addr: string | null;
  username: string | null;
  collection_id: string | null;
  collection_slug: string | null;
  nickname: string | null;
  cached_fmv_usd: number | null;
}

function emptyResponse(meta?: Record<string, unknown>) {
  return NextResponse.json({ gainers: [], losers: [], ...(meta ? { meta } : {}) });
}

export async function GET(req: NextRequest) {
  const days = Math.max(
    1,
    Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10) || 7, 90)
  );

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
        "[top-movers] get_user_saved_wallets failed:",
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

    const allGainers: Mover[] = [];
    const allLosers: Mover[] = [];

    // get_user_saved_wallets returns one row per (wallet x published
    // collection), so dedupe by address — get_top_movers is per-wallet and
    // returns all collections for it. (Results are also deduped by edition_id
    // below, so this is a perf/consistency guard, not the count fix.)
    const seenWallet = new Set<string>();

    for (const w of wallets) {
      const raw = w.wallet_addr ?? "";
      const addr = raw.startsWith("0x") ? raw : raw ? "0x" + raw : "";
      if (!addr || addr === "0x") continue;
      if (seenWallet.has(addr)) continue;
      seenWallet.add(addr);

      const { data, error } = await (supabase as any).rpc("get_top_movers", {
        p_wallet: addr,
        p_days: days,
      });
      if (error) {
        console.log(
          "[top-movers] get_top_movers failed for",
          addr,
          "message:",
          error.message,
          "code:",
          error.code ?? "unknown"
        );
        continue;
      }
      const payload = (data ?? {}) as { gainers?: Mover[]; losers?: Mover[] };
      if (Array.isArray(payload.gainers)) allGainers.push(...payload.gainers);
      if (Array.isArray(payload.losers)) allLosers.push(...payload.losers);
    }

    function dedupe(rows: Mover[]): Mover[] {
      const seen = new Set<string>();
      const out: Mover[] = [];
      for (const r of rows) {
        if (!r.edition_id || seen.has(r.edition_id)) continue;
        seen.add(r.edition_id);
        out.push(r);
      }
      return out;
    }

    const gainers = dedupe(allGainers)
      .sort(function (a, b) { return Number(b.delta) - Number(a.delta); })
      .slice(0, 5);
    const losers = dedupe(allLosers)
      .sort(function (a, b) { return Number(a.delta) - Number(b.delta); })
      .slice(0, 5);

    return NextResponse.json({ gainers, losers });
  } catch (err: any) {
    console.log(
      "[top-movers] unexpected:",
      err?.message ?? String(err),
      "code:",
      err?.code ?? "unknown"
    );
    return emptyResponse({ unexpected_error: true });
  }
}
