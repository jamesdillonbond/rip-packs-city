// app/api/public/insights/squeeze-check/route.ts
//
// PUBLIC INSIGHTS — Wallet Squeeze Exposure (the "paste your wallet" tool).
//
// Read-only JSON endpoint backing /insights/squeeze-check. Wraps the
// get_wallet_squeeze_exposure RPC shipped 2026-05-30 via
// audit_20260530_wallet_squeeze_exposure_rpc_for_concierge.
//
// Per the 2026-05-29 launch plan Week 2: "Paste your wallet, see what's
// actually liquid in your bag." Personal-data exposure is scoped to the
// caller's own wallet (no signup required because the user is naming the
// wallet themselves — same trust model as nbatopshot.com/profile/<addr>).
//
// Query params:
//   wallet=<0x...>    required
//
// CACHE: no-store (wallet-specific; cohort badge state changes hourly
// anyway). 5s rate limit per wallet via the standard /api/* throttle.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

function looksLikeFlowAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(s);
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const wallet = (new URL(req.url).searchParams.get("wallet") ?? "").trim().toLowerCase();

  if (!wallet) {
    return NextResponse.json({ error: "wallet param is required" }, { status: 400 });
  }
  if (!looksLikeFlowAddress(wallet)) {
    return NextResponse.json(
      { error: "wallet must look like a Flow address (0x + 16 hex chars)" },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("get_wallet_squeeze_exposure", {
    p_wallet: wallet,
  });

  if (error) {
    console.error("[public/insights/squeeze-check]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "get_wallet_squeeze_exposure",
      elapsed_ms: elapsedMs,
    },
    summary: data ?? null,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
