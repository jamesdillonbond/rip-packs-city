// app/api/cron/warm/route.ts
//
// Cold-start / cold-buffer warmer for the hot browse surfaces (Market + the
// edition pages). Measured 2026-07-06: the underlying RPCs are fast warm
// (get_topshot_sniper_deals ~79ms, get_edition_market_bundle ~8ms) but the
// FIRST hit after buffer eviction / a cold lambda is multi-second — the cause
// of the QA-reported "Market ~5-8s / UFC edition ~10s to first data". Running
// the two market RPCs on a business-hours cron keeps their shared hot tables
// (editions, fmv_snapshots, badge_editions, cached_listings_v2) resident in the
// DB buffer cache, so the first real user of each window pays the warm cost,
// not the cold one. The edition pages read the same tables, so warming here
// covers the UFC edition surface too — no brittle per-edition ids needed.
//
// Auth: Vercel cron injects `Authorization: Bearer $CRON_SECRET`; a manual run
// may pass INGEST instead. Schedule lives in vercel.json (business hours PT).
// Deliberately does NOT write pipeline_runs — a warmer is not a data pipeline;
// a missed tick just means one cold hit, no data harm.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The default (unfiltered, most-hit) market/sniper params — mirrors the
// dispatch in app/api/market/route.ts so we warm exactly what users pull.
const DEFAULT_ARGS = {
  p_min_discount: 0,
  p_max_price: 0,
  p_rarity: "all",
  p_team: "all",
  p_sort_by: "listed_desc",
  p_limit: 500,
} as const;

async function warmRpc(name: string): Promise<{ rpc: string; rows: number | null; ms: number; ok: boolean }> {
  const t0 = Date.now();
  try {
    const { data, error } = await (supabaseAdmin as any).rpc(name, DEFAULT_ARGS);
    if (error) {
      console.log(`[cron/warm] ${name} err: ${error.message}`);
      return { rpc: name, rows: null, ms: Date.now() - t0, ok: false };
    }
    return { rpc: name, rows: Array.isArray(data) ? data.length : null, ms: Date.now() - t0, ok: true };
  } catch (e: any) {
    console.log(`[cron/warm] ${name} threw: ${e?.message ?? e}`);
    return { rpc: name, rows: null, ms: Date.now() - t0, ok: false };
  }
}

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const authorized =
    (!!cronSecret && auth === `Bearer ${cronSecret}`) ||
    (!!ingest && auth === `Bearer ${ingest}`);
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Warm both market surfaces in parallel (the RPCs are collection-specific by
  // name). This touches editions / fmv_snapshots / badge_editions / listings —
  // the same hot tables the edition pages read — so the UFC edition surface is
  // covered too.
  const t0 = Date.now();
  const results = await Promise.all([
    warmRpc("get_topshot_sniper_deals"),
    warmRpc("get_allday_market_listings"),
  ]);

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    elapsed_ms: Date.now() - t0,
    warmed: results,
  });
}

export async function GET(request: NextRequest) {
  return run(request);
}
