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
// 2026-10-28 (All Day parity): two additions, both through lib/insights/squeeze-check.ts.
//   - `allday_squeeze`: the NFL All Day squeeze leg (the same read /insights/squeeze-check makes). Its failure
//     fails ONLY that section (`allday_squeeze_error: true`), never the report.
//   - `index_state`: a report built from zero cache rows ("0 rookie editions held", "0 of 17 WNBA sets") is not a
//     reading of a wallet we never scanned. indexed / empty (every trusted scan found 0) / not_indexed / unknown.
//
// Query params:
//   wallet=<0x...>   required, Flow address
//
// CACHE: no-store (wallet-specific).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { boardUnavailable } from "@/lib/insights/board-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { readSqueezeCheck, readWalletScanState } from "@/lib/insights/squeeze-check";

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

  const label = "api/public/insights/tc-report";
  const [reportRead, allday] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    boundedRead((supabase as any).rpc("get_wallet_tc_report", { p_wallet: wallet }), `${label}/get_wallet_tc_report`),
    readSqueezeCheck(supabase, wallet, "nfl-all-day", label),
  ]);
  const { data, error } = reportRead;

  if (error) {
    return boardUnavailable(error, "insights/tc-report");
  }

  const rollup = Array.isArray(data?.cross_collection) ? data.cross_collection : [];
  const hasAny = rollup.some((r: { moments?: unknown }) => Number(r?.moments) > 0);
  const scan = await readWalletScanState(supabase, wallet, hasAny, label);

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "get_wallet_tc_report",
      elapsed_ms: elapsedMs,
    },
    index_state: scan.index_state,
    last_scanned_at: scan.last_scanned_at,
    report: data ?? null,
    allday_squeeze: allday.error ? null : { index_state: allday.index_state, summary: allday.summary ?? null },
    allday_squeeze_error: allday.error ? true : false,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
