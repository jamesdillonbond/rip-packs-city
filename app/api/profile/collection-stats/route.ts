// app/api/profile/collection-stats/route.ts
//
// Returns live per-collection stats for a single wallet by calling the
// get_wallet_collection_stats RPC, which aggregates wallet_moments_cache
// in real time. Replaces the stale cached_fmv_usd / cached_moment_count
// fields on saved_wallets, which were never scoped per-collection.
//
// Public read by design: collection holdings are not sensitive and the
// profile page calls this once per saved wallet on every load.
//
// The underlying RPC operates on wallet_moments_cache.wallet_address (lower
// case) — there is no owner_key column anywhere in this chain. We normalize
// the input to lower-case so a user pasting `0xABC…` matches the cache.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { normalizeAddress } from "@/lib/address";

export const dynamic = "force-dynamic";
// MUST stay above the RPC's own statement_timeout (20s as of
// audit_20260806_get_wallet_collection_stats_drop_fmv_current_scan) or the lambda
// dies first on a cold whale wallet and the caller never sees the 57014 -> 503.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const started = Date.now();
  const walletAddrRaw = req.nextUrl.searchParams.get("wallet_addr");
  if (!walletAddrRaw) {
    return NextResponse.json({ error: "wallet_addr required" }, { status: 400 });
  }
  // normalizeAddress, NOT toLowerCase — base58 is case-sensitive, so
  // lowercasing a Candy (Solana) address makes it match no stored row.
  const walletAddr = normalizeAddress(walletAddrRaw);

  try {
    const { data, error } = await supabase.rpc("get_wallet_collection_stats", {
      p_wallet_addr: walletAddr,
    });

    const elapsedMs = Date.now() - started;

    if (error) {
      const code = (error as { code?: string }).code ?? null;
      const status = (error as { status?: number }).status ?? null;
      console.error(
        "[profile/collection-stats] rpc_error wallet=" + walletAddr +
          " code=" + code + " status=" + status +
          " elapsed_ms=" + elapsedMs +
          " msg=" + (error.message ?? "").slice(0, 300)
      );
      // Statement_timeout exhaustion shows up as code 57014 — surface as 503
      // so callers retry rather than treating it like a hard 500.
      if (code === "57014") {
        return NextResponse.json(
          { error: "stats_timeout", retry: true, wallet_addr: walletAddr, elapsed_ms: elapsedMs },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: error.message, code, wallet_addr: walletAddr, elapsed_ms: elapsedMs },
        { status: 500 }
      );
    }

    return NextResponse.json({
      wallet_addr: walletAddr,
      stats: data ?? [],
      elapsed_ms: elapsedMs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsedMs = Date.now() - started;
    console.error(
      "[profile/collection-stats] exception wallet=" + walletAddr +
        " elapsed_ms=" + elapsedMs +
        " msg=" + msg.slice(0, 300)
    );
    return NextResponse.json(
      { error: "internal_error", retry: true, message: msg, elapsed_ms: elapsedMs },
      { status: 503 }
    );
  }
}
