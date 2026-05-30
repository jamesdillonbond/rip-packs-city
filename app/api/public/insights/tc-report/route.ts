// app/api/public/insights/tc-report/route.ts
//
// PUBLIC INSIGHTS — Per-wallet Team-Captain-style report.
//
// Composite per-wallet report wrapping the get_wallet_tc_report RPC shipped
// 2026-05-30 via audit_20260530_get_wallet_tc_report_rpc. Returns a
// structured jsonb summary: cross-collection rollup, squeeze exposure,
// 2025 rookie cohort coverage, WNBA Series 7 coverage, top-5 set
// completion, and recent 90-day acquisitions.
//
// Powers the Week 3 launch-plan TC outreach workflow:
// > "Pull their primary wallet addresses. Run the report on each.
// >  Personalize the DM."
//
// Query params:
//   wallet=<0x...>   required, Flow address
//
// CACHE: no-store (wallet-specific).

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
  const { data, error } = await (supabase as any).rpc("get_wallet_tc_report", {
    p_wallet: wallet,
  });

  if (error) {
    console.error("[public/insights/tc-report]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "get_wallet_tc_report",
      elapsed_ms: elapsedMs,
    },
    report: data ?? null,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
