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
import { boardUnavailable } from "@/lib/insights/board-error";
import { boundedRead } from "@/lib/api/bounded-read";

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
  const { data, error } = await boundedRead((supabase as any).rpc("get_wallet_tc_report", {
    p_wallet: wallet,
  }), "api/public/insights/tc-report/get_wallet_tc_report");

  if (error) {
    return boardUnavailable(error, "insights/tc-report");
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
