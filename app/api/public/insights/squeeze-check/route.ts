// app/api/public/insights/squeeze-check/route.ts
//
// PUBLIC INSIGHTS — Wallet Squeeze Exposure (the "paste your wallet" tool).
//
// Read-only JSON endpoint backing /insights/squeeze-check. Wraps the per-collection exposure RPC
// (get_wallet_squeeze_exposure for Top Shot, shipped 2026-05-30; get_allday_wallet_squeeze_exposure for
// NFL All Day, 2026-10-27) through lib/insights/squeeze-check.ts, which the concierge shares.
//
// Per the 2026-05-29 launch plan Week 2: "Paste your wallet, see what's
// actually liquid in your bag." Personal-data exposure is scoped to the
// caller's own wallet (no signup required because the user is naming the
// wallet themselves — same trust model as nbatopshot.com/profile/<addr>).
//
// Query params:
//   wallet=<0x...>        required
//   collection=<slug>     optional — nba-top-shot (default when ABSENT) | nfl-all-day.
//                         ⛔ Any other value is a 400 with no rows: answering an unknown collection with
//                         Top Shot's exposure would be the substitution defect.
//
// Response: `summary` (the RPC's jsonb, or null) plus `index_state` — "indexed" | "empty" | "not_indexed" |
// "unknown" — so a wallet we have never scanned is never rendered as one that holds nothing.
//
// CACHE: no-store (wallet-specific; cohort badge state changes hourly
// anyway). 5s rate limit per wallet via the standard /api/* throttle.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { boardUnavailable } from "@/lib/insights/board-error";
import { isSqueezeCollection, type SqueezeCollection } from "@/lib/insights/squeeze-collections";
import { readSqueezeCheck } from "@/lib/insights/squeeze-check";

function looksLikeFlowAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{16}$/.test(s);
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const params = new URL(req.url).searchParams;
  const wallet = (params.get("wallet") ?? "").trim().toLowerCase();

  const rawCollection = params.get("collection");
  if (rawCollection != null && !isSqueezeCollection(rawCollection)) {
    return NextResponse.json(
      { error: "collection must be nba-top-shot or nfl-all-day" },
      { status: 400 }
    );
  }
  const collection: SqueezeCollection = rawCollection ?? "nba-top-shot";

  if (!wallet) {
    return NextResponse.json({ error: "wallet param is required" }, { status: 400 });
  }
  if (!looksLikeFlowAddress(wallet)) {
    return NextResponse.json(
      { error: "wallet must look like a Flow address (0x + 16 hex chars)" },
      { status: 400 }
    );
  }

  const read = await readSqueezeCheck(supabase, wallet, collection, "api/public/insights/squeeze-check");
  if (read.error) {
    return boardUnavailable(read.error, "insights/squeeze-check");
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: read.rpc,
      collection,
      elapsed_ms: elapsedMs,
    },
    index_state: read.index_state,
    last_scanned_at: read.last_scanned_at,
    summary: read.summary ?? null,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
