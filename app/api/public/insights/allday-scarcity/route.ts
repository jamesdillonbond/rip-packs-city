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
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_SORTS = new Set(["scarcity", "mint", "fmv"]);

const SELECT_COLS =
  "external_id, player_name, set_name, tier, team_name, series, mint_count, family_avg_mint, family_size, scarcity_vs_family_pct, fmv_usd, fmv_confidence, thumbnail_url";

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const sp = new URL(req.url).searchParams;

  const tier = sp.get("tier")?.trim() ?? null;
  const set = sp.get("set")?.trim() ?? null;
  const maxMint = sp.get("max_mint") ? Number(sp.get("max_mint")) : null;
  const minFamilySize = sp.get("min_family_size") ? Number(sp.get("min_family_size")) : 3;
  const minScarcity = sp.get("min_scarcity") ? Number(sp.get("min_scarcity")) : 0;
  const sort = sp.get("sort") ?? "scarcity";
  const limit = Math.max(1, Math.min(1000, Number(sp.get("limit") ?? "50")));

  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("allday_scarcity_board")
    .select(SELECT_COLS);

  // Cohort gate: only families with enough members to make the average mean
  // anything, and (by default) only editions actually scarcer than their family.
  if (Number.isFinite(minFamilySize)) q = q.gte("family_size", minFamilySize);
  if (Number.isFinite(minScarcity)) q = q.gt("scarcity_vs_family_pct", minScarcity);

  if (tier) q = q.eq("tier", tier.toUpperCase());
  if (set) q = q.ilike("set_name", `%${set}%`);
  if (maxMint != null && Number.isFinite(maxMint)) q = q.lte("mint_count", maxMint);

  if (sort === "scarcity") {
    q = q.order("scarcity_vs_family_pct", { ascending: false, nullsFirst: false });
  } else if (sort === "mint") {
    q = q.order("mint_count", { ascending: true });
  } else if (sort === "fmv") {
    q = q.order("fmv_usd", { ascending: false, nullsFirst: false });
  }
  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error("[public/insights/allday-scarcity]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "allday_scarcity_board",
      elapsed_ms: elapsedMs,
      total_rows: data?.length ?? 0,
      filters: { tier, set, max_mint: maxMint, min_family_size: minFamilySize, min_scarcity: minScarcity, sort, limit },
    },
    rows: data ?? [],
  });
  res.headers.set("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=300");
  return res;
}
