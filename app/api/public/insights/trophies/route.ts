// app/api/public/insights/trophies/route.ts
//
// PUBLIC INSIGHTS — Trophy Room. The rarest grail editions across Flow:
// every 1-of-1 edition plus Ultimate-tier moments, ranked by FMV.
//
// Read-only JSON endpoint backing /insights/trophies. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth.
// Reads the public `v_insights_trophies` view (shipped 2026-06-13 via
// `audit_20260613_v_insights_trophies`, security_invoker=on, granted to
// anon) which filters editions to is_one_of_one OR is_ultimate WHERE
// thumbnail_url IS NOT NULL and laterals the latest FMV per edition off
// idx_fmv_edition_time. Bounded (~683 rows), sub-second.
//
// Why this exists: trophy-hunting is core collector behavior and none of
// the other public /insights surfaces cover it. Top Shot's own site shows
// nominal circulation; we surface the grails — 1-of-1s and Ultimates — with
// honest FMV + confidence. Most grails rarely trade, so FMV is mostly
// ASK_ONLY / STALE / NULL by design (see the page's honesty framing).
//
// Query params:
//   collection=nba_top_shot|nfl_all_day        single-collection filter
//   type=one_of_one|ultimate|all               trophy class (default all)
//   sort=fmv|circulation                       default fmv (desc, nulls last)
//   limit=<1..500>                             default 200
//
// Response:
//   {
//     meta: { fetched_at, source, total_rows, elapsed_ms, filters },
//     rows: [{ edition_id, external_id, collection, collection_id, name,
//              player_name, set_name, team_name, tier, series,
//              circulation_count, thumbnail_url, video_url, is_one_of_one,
//              is_ultimate, fmv_usd, confidence, fmv_computed_at }, ...]
//   }
//
// CACHE: 1-hour s-maxage. FMV recomputes on its own cron and trophies move
// slowly, so an hour is well inside the freshness window and protects the
// DB from a viral OG-share spike.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";

const VALID_COLLECTIONS = new Set(["nba_top_shot", "nfl_all_day"]);
const VALID_TYPES = new Set(["one_of_one", "ultimate", "all"]);
const VALID_SORTS = new Set(["fmv", "circulation"]);

const SELECT_COLS =
  "edition_id, external_id, collection, collection_id, name, player_name, set_name, team_name, tier, series, circulation_count, thumbnail_url, video_url, is_one_of_one, is_ultimate, fmv_usd, confidence, fmv_computed_at";

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const sp = new URL(req.url).searchParams;

  const collection = sp.get("collection")?.trim().toLowerCase() ?? null;
  const type = (sp.get("type")?.trim().toLowerCase() ?? "all") || "all";
  const sort = sp.get("sort") ?? "fmv";
  const limit = Math.max(1, Math.min(500, Number(sp.get("limit") ?? "200")));

  if (collection && !VALID_COLLECTIONS.has(collection)) {
    return NextResponse.json(
      { error: `collection must be one of ${[...VALID_COLLECTIONS].join(",")}` },
      { status: 400 }
    );
  }
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json(
      { error: `type must be one of ${[...VALID_TYPES].join(",")}` },
      { status: 400 }
    );
  }
  if (!VALID_SORTS.has(sort)) {
    return NextResponse.json(
      { error: `sort must be one of ${[...VALID_SORTS].join(",")}` },
      { status: 400 }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (supabase as any).from("v_insights_trophies").select(SELECT_COLS);

  if (collection) q = q.eq("collection", collection);
  if (type === "one_of_one") q = q.eq("is_one_of_one", true);
  else if (type === "ultimate") q = q.eq("is_ultimate", true);

  // FMV-desc (nulls last) is the canonical "headline grails first" ranking so
  // the priced trophies lead and the never-traded grails follow. Circulation
  // sort surfaces the 1-of-1s first.
  if (sort === "circulation") {
    q = q
      .order("circulation_count", { ascending: true, nullsFirst: false })
      .order("fmv_usd", { ascending: false, nullsFirst: false });
  } else {
    q = q
      .order("fmv_usd", { ascending: false, nullsFirst: false })
      .order("circulation_count", { ascending: true, nullsFirst: false });
  }

  q = q.limit(limit);

  const { data, error } = await q;
  if (error) {
    console.error("[public/insights/trophies]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[public/insights/trophies] returned=${data?.length ?? 0} collection=${collection ?? "*"} type=${type} sort=${sort} elapsedMs=${elapsedMs}`
  );

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "v_insights_trophies",
      total_rows: data?.length ?? 0,
      elapsed_ms: elapsedMs,
      filters: { collection, type, sort, limit },
    },
    rows: data ?? [],
  });

  // 1-hour edge cache. FMV recomputes on its own cron; trophies move slowly.
  res.headers.set("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=300");
  return res;
}
