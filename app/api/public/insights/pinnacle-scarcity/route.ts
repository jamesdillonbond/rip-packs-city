// app/api/public/insights/pinnacle-scarcity/route.ts
//
// PUBLIC INSIGHTS — Disney Pinnacle Scarcity Board.
//
// Sister surface to /insights/squeeze, scoped to Pinnacle. Pinnacle doesn't
// have TS's lock+burn mechanic — scarcity comes from low mint counts,
// chaser status, and premium variants. This view ranks Pinnacle editions
// by how far below their variant family's average mint they sit.
//
// Backing view shipped 2026-05-30 via
// audit_20260530_pinnacle_scarcity_board_view_for_surface_h.
//
// Query params:
//   variant=<text>           ilike match on variant_type (e.g. Digital Display)
//   franchise=<text>         ilike match on franchise (e.g. Star Wars, Pixar)
//   max_mint=<int>           ceiling on mint_count
//   chasers_only=true        filter to is_chaser=true rows only
//   sort=scarcity|mint|fmv   default scarcity
//   limit=<1..200>           default 50
//
// CACHE: 30-min s-maxage (pinnacle_editions changes slowly, fmv hourly).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_SORTS = new Set(["scarcity", "mint", "fmv"]);

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const sp = new URL(req.url).searchParams;

  const variant = sp.get("variant")?.trim() ?? null;
  const franchise = sp.get("franchise")?.trim() ?? null;
  const maxMint = sp.get("max_mint") ? Number(sp.get("max_mint")) : null;
  const chasersOnly = sp.get("chasers_only") === "true";
  const sort = sp.get("sort") ?? "scarcity";
  const limit = Math.max(1, Math.min(200, Number(sp.get("limit") ?? "50")));

  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any)
    .from("pinnacle_scarcity_board")
    .select(
      "edition_id, character_name, franchise, set_name, variant_type, mint_count, is_chaser, ask_price, variant_avg_mint, scarcity_vs_variant_pct, fmv_usd, fmv_confidence, thumbnail_url"
    );

  if (variant) q = q.ilike("variant_type", `%${variant}%`);
  if (franchise) q = q.ilike("franchise", `%${franchise}%`);
  if (maxMint != null && Number.isFinite(maxMint)) q = q.lte("mint_count", maxMint);
  if (chasersOnly) q = q.eq("is_chaser", true);

  if (sort === "scarcity") {
    q = q.order("scarcity_vs_variant_pct", { ascending: false, nullsFirst: false });
  } else if (sort === "mint") {
    q = q.order("mint_count", { ascending: true });
  } else if (sort === "fmv") {
    q = q.order("fmv_usd", { ascending: false, nullsFirst: false });
  }
  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error("[public/insights/pinnacle-scarcity]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "pinnacle_scarcity_board",
      elapsed_ms: elapsedMs,
      total_rows: data?.length ?? 0,
      filters: { variant, franchise, max_mint: maxMint, chasers_only: chasersOnly, sort, limit },
    },
    rows: data ?? [],
  });
  res.headers.set("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=300");
  return res;
}
