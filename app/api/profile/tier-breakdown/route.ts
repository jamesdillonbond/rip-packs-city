// app/api/profile/tier-breakdown/route.ts
//
// GET /api/profile/tier-breakdown[?ownerKey=username]
// Aggregates wallet_moments_cache tier counts across the saved wallets of a
// target user. With ?ownerKey=username (the public path used by the profile
// page) the user is resolved through profile_bio — holdings are PUBLIC on a
// collector showcase, so this path is unauthenticated. Without ownerKey it
// falls back to the current authenticated user (dashboard own-view).
//
// Uses the SECDEF helper get_user_saved_wallets(p_user_id) to bypass the
// saved_wallets RLS gap the dashboard was hitting (post-R3 follow-up,
// 2026-05-09): saved_wallets rows are keyed on user_id and the JWT-forwarding
// gap was the actual root cause of the dashboard showing empty data. The
// SECDEF helper sidesteps that entirely.
//
// Failure modes:
//   - ownerKey not found                  → empty shape, meta.owner_not_found
//   - not signed in / cookie missing      → empty shape, meta.unauthenticated
//   - SECDEF helper RPC errors            → empty shape, meta.saved_wallets_unavailable
//   - user has zero saved_wallets         → empty shape, meta.no_wallets
//   - every wallet returns zero counts    → empty shape, meta.coverage_zero (consumer
//                                            renders explanatory empty state, not a
//                                            broken chart)
//
// Logs include error.message + error.code in plain console.log lines so
// Vercel log search can pick them up.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";

const TIER_ORDER = ["Common", "Fandom", "Rare", "Legendary", "Ultimate"];

function emptyResponse(meta?: Record<string, unknown>) {
  return NextResponse.json({ tiers: [], total: 0, ...(meta ? { meta } : {}) });
}

// Resolve a public ownerKey (username) → user_id the same way the other
// public ownerKey-driven profile endpoints (teams, portfolio-history) do.
async function resolveUserId(ownerKey: string): Promise<string | null> {
  const { data, error } = await (supabase as any)
    .from("profile_bio")
    .select("user_id")
    .ilike("username", ownerKey)
    .maybeSingle();
  if (error) {
    console.log("[tier-breakdown] resolveUserId failed:", error.message);
    return null;
  }
  return (data as any)?.user_id ?? null;
}

interface SavedWallet {
  wallet_addr: string | null;
  username: string | null;
  collection_id: string | null;
  collection_slug: string | null;
  nickname: string | null;
  cached_fmv_usd: number | null;
}

export async function GET(req: NextRequest) {
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
        "[tier-breakdown] get_user_saved_wallets failed:",
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

    const aggregate: Record<string, number> = {};
    let total = 0;
    let walletsAttempted = 0;
    let walletsWithRpcError = 0;

    // get_user_saved_wallets returns one row per (wallet x published
    // collection). get_wallet_tier_counts is per-wallet, so dedupe by
    // address — counting it per collection-row inflated tier counts ~4x.
    const seenTier = new Set<string>();

    for (const w of wallets) {
      const raw = w.wallet_addr ?? "";
      const addr = raw.startsWith("0x") ? raw : raw ? "0x" + raw : "";
      if (!addr || addr === "0x") continue;
      if (seenTier.has(addr)) continue;
      seenTier.add(addr);
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
      return emptyResponse({
        coverage_zero: true,
        wallets_attempted: walletsAttempted,
        wallets_with_rpc_error: walletsWithRpcError,
      });
    }

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
