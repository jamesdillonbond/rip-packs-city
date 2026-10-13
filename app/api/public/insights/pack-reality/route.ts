// app/api/public/insights/pack-reality/route.ts
//
// PUBLIC INSIGHTS — Top Shot Pack Reality.
//
// Read-only JSON endpoint backing /insights/pack-reality. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth.
//
// The READ lives in lib/insights/topshot-pack-reality.ts (review E2, 2026-10-13)
// so the page's server-seeded first frame and this route are one body — the
// five legs, their per-leg degradation and the model-vs-reality buckets are
// documented there. This file owns only the HTTP contract:
//
// Query params:
//   limit=<1..100>          default 10, applies only to the top_ev list
//
// Response: { meta, stats, distribution, top_ev, model_vs_reality }
//   meta.errors names any backing surface that failed THIS request. Each leg
//   degrades independently (2026-08-02); only an all-four outage returns a
//   classified 503/500 via boardUnavailable.
//
// CACHE: 5-minute s-maxage (pack_rips refreshes hourly; pack_ev_latest
// hourly via the pack-ev refresh cron — 5m well inside both windows). A
// partial failure (some legs in meta.errors) is not cached at the CDN (2026-10-09).

import { NextRequest, NextResponse } from "next/server";
import { boardUnavailable } from "@/lib/insights/board-error";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { clampPackRealityLimit, readTopshotPackReality } from "@/lib/insights/topshot-pack-reality";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = clampPackRealityLimit(url.searchParams.get("limit"));

  const read = await readTopshotPackReality(supabase, limit);
  if (read.totalOutage) {
    // Total outage stays loud, but classified: a statement timeout becomes a
    // retryable 503 rather than a 500 carrying Postgres's own wording.
    return boardUnavailable(read.error, "insights/pack-reality");
  }

  const res = NextResponse.json(read.body);
  res.headers.set("Cache-Control", read.errors.length > 0 ? "no-store" : "public, s-maxage=300, stale-while-revalidate=60");
  return res;
}
