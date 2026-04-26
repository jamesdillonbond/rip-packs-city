// app/api/profile/collection-stats/route.ts
//
// Returns live per-collection stats for a single wallet by calling the
// get_wallet_collection_stats RPC, which aggregates wallet_moments_cache
// in real time. Replaces the stale cached_fmv_usd / cached_moment_count
// fields on saved_wallets, which were never scoped per-collection.
//
// Public read by design: collection holdings are not sensitive and the
// profile page calls this once per saved wallet on every load.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const walletAddrRaw = req.nextUrl.searchParams.get("wallet_addr");
  if (!walletAddrRaw) {
    return NextResponse.json({ error: "wallet_addr required" }, { status: 400 });
  }
  const walletAddr = walletAddrRaw.trim().toLowerCase();

  const { data, error } = await supabase.rpc("get_wallet_collection_stats", {
    p_wallet_addr: walletAddr,
  });

  if (error) {
    console.error("[profile/collection-stats]", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ wallet_addr: walletAddr, stats: data ?? [] });
}
