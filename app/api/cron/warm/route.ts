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
import { fetchUnderpricedSerials } from "@/lib/underpriced-serials-board";

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

// Warm the PUBLIC Underpriced-#1s board.
//
// 🚨 WHY IT IS HERE AND NOT IN `WARM_BOARDS`. Measured 2026-08-26, the same
// statement twice inside one DO block so the second is warm by construction:
// **cold 19,895 ms / warm 32 ms — 622x** — on a working set of just 3,069
// buffers and 230 disk reads. At this instance's ~74 ms per cold random read,
// 230 x 74 ms ~= 17 s, which IS the number. **There is no plan defect and
// nothing to optimise**: the board is tiny and simply always cold, because a
// 15-minute `s-maxage` on a low-traffic public route means nearly every
// execution is the first in a long while. Live effect:
// `GET /api/public/insights/underpriced-serials` -> **503 after 62 s**.
//
// ⛔ The obvious home is `WARM_BOARDS` / refresh-insights-cache, and
// inbox 2026-08-15T1200Z argues against it with numbers: three of that cron's
// five boards already FAIL the majority of ticks (59.5% / 54.2% / 51.0%), its
// six board means sum to ~60.0 s = the route's entire maxDuration, and each
// failed warm burns ~30 s of DB time producing nothing — *"a meaningful
// contributor to the saturation it exists to survive"*. Adding a sixth board to
// a Promise.all already losing three of five is a plausible way to make it four
// of six.
//
// ⭐ This warmer is a different instrument: a pure BUFFER warmer, not a snapshot
// writer, so it adds ~32 ms of sustained work rather than a 30 s write cycle.
// A board that costs 32 ms warm is close to free to keep warm; only the first
// tick pays the cold price.
//
// ⚠ Deliberately NOT the snapshot cache, which would be strictly better for
// users (it survives saturation on a PK-keyed row and gains the stale-but-honest
// rung) — that is the contention trade the 08-15 filing reserves for Trevor, and
// it is a bigger change than a freshness fix needs to be.
//
// Defaults mirror the route's own parse defaults (headline all / quality all /
// minDiscount 0 / sort discount / limit 100) so we warm exactly what an
// unfiltered visitor pulls. ⓘ `opts.limit` is applied in JS AFTER a fixed
// `.limit(500)`, so every filter combination runs the same query — warming the
// default warms them all.
async function warmUnderpricedSerials(): Promise<{ rpc: string; rows: number | null; ms: number; ok: boolean }> {
  const t0 = Date.now();
  try {
    const rows = await fetchUnderpricedSerials(supabaseAdmin as any, {
      headline: "all",
      tier: null,
      quality: "all",
      minDiscount: 0,
      sort: "discount",
      limit: 100,
    });
    return { rpc: "underpriced_serials_board", rows: rows.length, ms: Date.now() - t0, ok: true };
  } catch (e: any) {
    console.log(`[cron/warm] underpriced_serials threw: ${e?.message ?? e}`);
    return { rpc: "underpriced_serials_board", rows: null, ms: Date.now() - t0, ok: false };
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
    warmUnderpricedSerials(),
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
