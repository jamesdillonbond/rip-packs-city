// app/api/admin/pipeline-health/route.ts
//
// GET /api/admin/pipeline-health
// Authorization: Bearer <RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN>
//
// Cron drift surface for /admin/pipeline-health. For each known pipeline,
// compares its most recent pipeline_runs row against the expected cadence
// and tags drift severity (green / yellow / red). Includes a list of
// "expected but missing" pipelines that should be running but have no
// rows in the trailing 24h window.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Expected cadence per pipeline. Sourced from CLAUDE.md ("23 active
// pipelines, */20 cadence dominant") + the cron-job.org schedule. When in
// doubt we err on the side of "less frequently than reality" so a pipeline
// hitting its expected cadence reads as green, not red.
const EXPECTED_INTERVAL_MIN: Record<string, number> = {
  // Listings — high cadence
  "ts-listing-ingest": 20,
  "topshot-listing-cache": 20,
  "topshot-listing-cache-v2": 20,
  "allday-listing-cache": 20,
  "allday-listings-indexer": 20,
  "golazos-listing-cache": 20,
  "ufc-listing-cache": 20,
  "pinnacle-listing-cache": 20,
  "sync-flowty-listings": 20,
  // Sales indexers
  "topshot-sales-indexer": 20,
  "allday-sales-indexer": 20,
  "golazos-sales-indexer": 20,
  "ufc-sales-indexer": 20,
  "pinnacle-resolve-buyers": 20,
  "pinnacle-nft-resolver": 5,
  "promote_unmapped_sales": 5,
  "allday-unmapped-resolver": 20,
  "allday-edition-resolver": 20,
  // FMV
  "wmc-fmv-populate": 5,
  "allday-fmv-populate": 20,
  "fmv-recalc": 20,
  "ultimate-fmv-recalc-v1": 60,
  // Pack EV
  "compute-topshot-pack-ev": 30,
  "compute-allday-pack-ev": 60,
  // Owner-side
  "pinnacle-owner-discovery": 60,
  "pinnacle-owner-discovery-forward": 30,
  "hybrid_custody_events": 20,
  // Wallet backfill chain
  "wallet-backfill": 360,
  "wallet-backfill-allday": 360,
  "wallet-backfill-pinnacle": 360,
  "wallet-backfill-golazos": 360,
  "wallet-backfill-ufc": 360,
  // Other
  "classify-acquisitions": 20,
  "check-alerts": 20,
  "editions-hydrate-at-insert": 30,
  "sync-nba-projections": 60,
  "sync-nba-odds": 60,
  "weekly-db-maintenance": 60 * 24 * 7,
  "allow-list-reconcile": 60 * 6,
  "listing-divergence-snapshot": 360,
  "apply-fmv-haircut": 60,
};

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const admin = process.env.RPC_ADMIN_TOKEN;
  if (ingest && auth === `Bearer ${ingest}`) return true;
  if (admin && auth === `Bearer ${admin}`) return true;
  return false;
}

interface PipelineRow {
  pipeline: string;
  runs_6h: number;
  fails_6h: number;
  last_run: string | null;
  expected_min: number | null;
  minutes_since: number | null;
  drift: "green" | "yellow" | "red";
  expected_but_missing: boolean;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = supabaseAdmin as any;

  // Single SQL pull — last 24h of pipeline_runs aggregated per pipeline.
  // We need 24h to detect "expected but no run in window," but only the 6h
  // counts go into the visible "runs/fails" columns.
  const { data: rowsRaw, error } = await sb.rpc("query_sql", {
    query: `
      SELECT
        pipeline,
        MAX(started_at) AS last_run,
        COUNT(*) FILTER (WHERE started_at > now() - interval '6 hours') AS runs_6h,
        COUNT(*) FILTER (WHERE started_at > now() - interval '6 hours' AND NOT ok) AS fails_6h
      FROM pipeline_runs
      WHERE started_at > now() - interval '24 hours'
      GROUP BY pipeline
    `,
  });

  if (error) {
    return NextResponse.json(
      { error: error.message, code: (error as { code?: string }).code ?? null },
      { status: 500 }
    );
  }

  const seenInWindow = new Map<
    string,
    { runs6h: number; fails6h: number; lastRun: string | null }
  >();
  for (const r of (rowsRaw ?? []) as Array<{
    pipeline: string;
    last_run: string | null;
    runs_6h: number;
    fails_6h: number;
  }>) {
    seenInWindow.set(r.pipeline, {
      runs6h: Number(r.runs_6h ?? 0),
      fails6h: Number(r.fails_6h ?? 0),
      lastRun: r.last_run ?? null,
    });
  }

  const now = Date.now();
  function classify(pipeline: string, lastRun: string | null, expectedMin: number | null): {
    drift: "green" | "yellow" | "red";
    minutesSince: number | null;
    expectedButMissing: boolean;
  } {
    if (!lastRun) {
      return { drift: "red", minutesSince: null, expectedButMissing: true };
    }
    const minutesSince = Math.floor((now - new Date(lastRun).getTime()) / 60000);
    if (expectedMin == null) {
      // Unknown cadence — only red if we haven't heard from it in 24h.
      return {
        drift: minutesSince > 24 * 60 ? "red" : "green",
        minutesSince,
        expectedButMissing: false,
      };
    }
    if (minutesSince > 24 * 60) {
      return { drift: "red", minutesSince, expectedButMissing: false };
    }
    if (minutesSince > expectedMin * 5) return { drift: "red", minutesSince, expectedButMissing: false };
    if (minutesSince > expectedMin * 2) return { drift: "yellow", minutesSince, expectedButMissing: false };
    return { drift: "green", minutesSince, expectedButMissing: false };
  }

  // Union of "we expected this pipeline to run" + "we saw it run."
  const allPipelineNames = new Set<string>([
    ...Object.keys(EXPECTED_INTERVAL_MIN),
    ...seenInWindow.keys(),
  ]);

  const out: PipelineRow[] = [];
  for (const name of allPipelineNames) {
    const seen = seenInWindow.get(name);
    const expectedMin = EXPECTED_INTERVAL_MIN[name] ?? null;
    const lastRun = seen?.lastRun ?? null;
    const { drift, minutesSince, expectedButMissing } = classify(name, lastRun, expectedMin);
    out.push({
      pipeline: name,
      runs_6h: seen?.runs6h ?? 0,
      fails_6h: seen?.fails6h ?? 0,
      last_run: lastRun,
      expected_min: expectedMin,
      minutes_since: minutesSince,
      drift,
      // expected_but_missing means: we have a cadence expectation AND no run
      // in the last 24h. That's distinct from generic red.
      expected_but_missing: expectedMin != null && expectedButMissing,
    });
  }

  // Sort red first, then yellow, then green. Within each bucket the
  // longest-stale one floats up.
  const driftRank: Record<PipelineRow["drift"], number> = { red: 0, yellow: 1, green: 2 };
  out.sort((a, b) => {
    const dr = driftRank[a.drift] - driftRank[b.drift];
    if (dr !== 0) return dr;
    const am = a.minutes_since ?? Number.MAX_SAFE_INTEGER;
    const bm = b.minutes_since ?? Number.MAX_SAFE_INTEGER;
    return bm - am;
  });

  const summary = {
    red: out.filter((r) => r.drift === "red").length,
    yellow: out.filter((r) => r.drift === "yellow").length,
    green: out.filter((r) => r.drift === "green").length,
    expected_but_missing: out.filter((r) => r.expected_but_missing).length,
  };

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    summary,
    rows: out,
  });
}
