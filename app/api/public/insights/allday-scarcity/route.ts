// app/api/public/insights/allday-scarcity/route.ts
//
// PUBLIC INSIGHTS — NFL All Day Scarcity Board.
//
// Sister surface to /insights/pinnacle-scarcity, scoped to NFL All Day. All Day
// has neither Top Shot's lock+burn mechanic nor Pinnacle's per-render variants —
// scarcity is measured the Pinnacle way: how far below an edition's comparable
// family's average mint it sits. Family = (set_name, tier).
//
// Backing view shipped 2026-06-23 via audit_20260623_allday_scarcity_board_view
// (security_invoker, anon SELECT).
//
// Query params:
//   tier=<text>              exact tier match (LEGENDARY / RARE / UNCOMMON / …)
//   set=<text>               ilike match on set_name
//   max_mint=<int>           ceiling on mint_count
//   min_family_size=<int>    floor on family_size (default 3 — statistical floor)
//   min_scarcity=<num>       floor on scarcity_vs_family_pct (default 0 → only
//                            editions scarcer than their family; pass a negative
//                            value to include above-average-mint editions too)
//   sort=scarcity|mint|fmv   default scarcity
//   limit=<1..1000>          default 50
//
// CACHE: 30-min s-maxage (editions + circulation change slowly, fmv hourly).

import { NextRequest, NextResponse } from "next/server";
import { boardUnavailable } from "@/lib/insights/board-error";

import { boardRowMeta } from "@/lib/insights/board-meta"
import { fetchAllDayScarcityBoard } from "@/lib/insights/allday-scarcity-board"
const VALID_SORTS = new Set(["scarcity", "mint", "fmv"]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const sp = new URL(req.url).searchParams;

  const tier = sp.get("tier")?.trim() ?? null;
  const set = sp.get("set")?.trim() ?? null;
  const maxMint = sp.get("max_mint") ? Number(sp.get("max_mint")) : null;
  const minFamilySize = sp.get("min_family_size") ? Number(sp.get("min_family_size")) : 3;
  const minScarcity = sp.get("min_scarcity") ? Number(sp.get("min_scarcity")) : 0;
  const sort = sp.get("sort") ?? "scarcity";
  const limit = Math.max(1, Math.min(1000, Number(sp.get("limit")) || 50));

  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }

  const { data, error } = await fetchAllDayScarcityBoard({
    tier,
    set,
    maxMint,
    minFamilySize,
    minScarcity,
    sort,
    limit,
  });
  if (error) {
    return boardUnavailable(error, "insights/allday-scarcity");
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "allday_scarcity_board",
      elapsed_ms: elapsedMs,
      ...boardRowMeta(data?.length ?? 0, limit),
      filters: { tier, set, max_mint: maxMint, min_family_size: minFamilySize, min_scarcity: minScarcity, sort, limit },
    },
    rows: data ?? [],
  });
  res.headers.set("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=300");
  return res;
}
