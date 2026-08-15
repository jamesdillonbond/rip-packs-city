// app/api/public/insights/set-squeeze/route.ts
//
// PUBLIC INSIGHTS — Top Shot per-set squeeze leaderboard.
//
// Drill-down companion to Surface A (per-edition). Ranks entire sets by
// average squeeze % across covered editions. Backing view shipped
// 2026-05-30 via audit_20260530_topshot_squeeze_by_set_view_for_surface_g.
//
// Why this matters: "If I'm trying to complete this set, how scarce is it
// going to be?" is a different question from per-edition squeeze. The
// launch plan's "2023 Freshman Gems is 90%+ locked across the board"
// callout lives here.
//
// Query params:
//   series=<int>           filter to a single series (5/6/7/8)
//   set_tier=COMMON|RARE|LEGENDARY|FANDOM|ULTIMATE   filter tier
//   sort=squeeze|buyable   default squeeze
//   limit=<1..100>         default 50
//
// CACHE: 5-min s-maxage.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { boardUnavailable } from "@/lib/insights/board-error";
import { fetchSetSqueezeBoard } from "@/lib/insights/set-squeeze-board";

import { boardRowMeta } from "@/lib/insights/board-meta"
const VALID_TIERS = new Set(["COMMON", "RARE", "LEGENDARY", "FANDOM", "ULTIMATE"]);
const VALID_SORTS = new Set(["squeeze", "buyable"]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const sp = new URL(req.url).searchParams;

  const series = sp.get("series") ? Number(sp.get("series")) : null;
  const setTier = sp.get("set_tier")?.toUpperCase() ?? null;
  const sort = sp.get("sort") ?? "squeeze";
  const limit = Math.max(1, Math.min(100, Number(sp.get("limit")) || 50));

  if (setTier && !VALID_TIERS.has(setTier)) {
    return NextResponse.json(
      { error: `set_tier must be one of ${[...VALID_TIERS].join(",")}` },
      { status: 400 }
    );
  }
  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }
  if (series != null && !Number.isFinite(series)) {
    return NextResponse.json({ error: "series must be an integer" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // The QUERY lives in lib/insights/set-squeeze-board.ts, shared with the server page
  // so the crawlable board and this route cannot drift. This route keeps its
  // own failure policy (boardUnavailable).
  const { data, error } = await fetchSetSqueezeBoard(
    { series, setTier, sort, limit },
    supabase,
  );
  if (error) {
    return boardUnavailable(error, "insights/set-squeeze");
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "topshot_set_squeeze_board",
      elapsed_ms: elapsedMs,
      ...boardRowMeta(data?.length ?? 0, limit),
      filters: { series, set_tier: setTier, sort, limit },
    },
    rows: data ?? [],
  });
  res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
