// app/api/profile/top-movers/route.ts
//
// GET /api/profile/top-movers?days=7[&ownerKey=username]
// Merges get_top_movers gainers/losers across the saved wallets of a target
// user, returning the top 5 of each by dollar change. With ?ownerKey=username
// (the public path used by the profile page) the user is resolved through
// profile_bio — holdings are PUBLIC on a collector showcase, so this path is
// unauthenticated. Without ownerKey it falls back to the current authenticated
// user (dashboard own-view). Owner-scoping is also what fixes the "Top Movers
// reads empty" bug on public profiles (anon previously had no wallets).
//
// Uses the SECDEF helper get_user_saved_wallets(p_user_id) to read the
// wallet list — service-role client bypasses the JWT-forwarding gap that
// was making the post-R3 endpoints return empty even when wallets exist.
//
// Failure modes: unauthenticated / owner_not_found /
// saved_wallets_unavailable / no_wallets / unexpected_error all return
// the empty shape { gainers: [], losers: [] } so the page renders an
// empty state instead of breaking.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

// Resolve a public ownerKey (username) → user_id the same way the other
// public ownerKey-driven profile endpoints (teams, portfolio-history) do.
async function resolveUserId(ownerKey: string): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from("profile_bio")
    .select("user_id")
    .ilike("username", ownerKey)
    .maybeSingle();
  if (error) {
    console.log("[top-movers] resolveUserId failed:", error.message);
    return null;
  }
  return (data as any)?.user_id ?? null;
}

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

  // Public ownerKey path (profile page) vs authenticated own-view fallback.
  const ownerKey = (req.nextUrl.searchParams.get("ownerKey") ?? "").trim();
  let userId: string | null = null;
  if (ownerKey) {
    userId = await resolveUserId(ownerKey);
    if (!userId) {
      return emptyResponse({ owner_not_found: true });
    }
  } else {
    const user = await getCurrentUser();
    if (!user) {
      return emptyResponse({ unauthenticated: true });
    }
    userId = user.id;
  }

  try {
    const { data: walletsRaw, error: walletsError } = await (supabase as any).rpc(
      "get_user_saved_wallets",
      { p_user_id: userId }
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
