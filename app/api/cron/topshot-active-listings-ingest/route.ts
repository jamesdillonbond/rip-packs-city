import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────────────────────
// Underpriced #1s deal-board ingest — DB-I/O half (the Atlas fetch CANNOT live
// here).
//
// The per-serial TS ask feed is the public Dapper Atlas API
// (api.production.atlas.dapperlabs.com). Its WAF 403-blocks Node/undici `fetch`
// — VERIFIED 2026-06-16 from a real Vercel function (iad1), on both minimal and
// enriched headers — but ALLOWS curl/browser. So the Atlas calls run on a
// GitHub-Actions runner (curl), and that runner talks to THIS route for all DB
// I/O via the existing INGEST token. The service-role key never leaves Vercel,
// and no new GitHub secret surface is created.
//
// Runner protocol (scripts/ingest-topshot-active-listings.mjs):
//   GET  ?phase=targets&floor=N  -> { targets:[{rpc_edition_id, external_id,
//                                     atlas_edition_id, circulation_count, tier,
//                                     no1_estimate_usd, perfect_estimate_usd}] }
//   POST { rows:[...] }                 -> upsert active listings (chunked)
//   POST { deactivate:true, startedAt, ok, stats } -> deactivate stale + log run
//
// Auth: Bearer INGEST_SECRET_TOKEN (or CRON_SECRET). Methods: GET, POST.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "topshot-active-listings-ingest";
const DEFAULT_FLOOR = 100;
const STALE_MAX_AGE = "6 hours";

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (process.env.INGEST_SECRET_TOKEN && auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}`) return true;
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (req.nextUrl.searchParams.get("phase") !== "targets") {
    return NextResponse.json({ error: "unknown phase (use ?phase=targets)" }, { status: 400 });
  }
  const floorRaw = req.nextUrl.searchParams.get("floor");
  const floor = floorRaw != null && floorRaw !== "" ? Number(floorRaw) : DEFAULT_FLOOR;
  if (!Number.isFinite(floor) || floor < 0) {
    return NextResponse.json({ error: "bad floor" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc("topshot_serial_board_targets", { p_min_no1_estimate: floor });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const targets = (data as unknown[]) ?? [];
  return NextResponse.json({ floor, count: targets.length, targets }, { status: 200 });
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const rows = Array.isArray(body.rows) ? (body.rows as unknown[]) : [];
  let upserted = 0;
  let deactivated = 0;

  if (rows.length) {
    const { data, error } = await supabaseAdmin.rpc("upsert_topshot_active_listings", { p_rows: rows });
    if (error) return NextResponse.json({ error: `upsert: ${error.message}` }, { status: 500 });
    upserted = typeof data === "number" ? data : 0;
  }

  // Deactivation is decoupled from logging: a sweep whose egress was WAF-blocked
  // must still LOG (as a failure) but must NOT deactivate (that would empty the
  // board). The runner sends deactivate:true only on a healthy sweep, and
  // final:true on every terminal POST.
  if (body.deactivate) {
    const { data, error } = await supabaseAdmin.rpc("deactivate_stale_topshot_active_listings", {
      p_max_age: STALE_MAX_AGE,
    });
    if (error) return NextResponse.json({ error: `deactivate: ${error.message}` }, { status: 500 });
    deactivated = typeof data === "number" ? data : 0;
  }

  if (body.final || body.deactivate) {
    // Sweep finished — log one pipeline_runs row with the runner's cumulative stats.
    const stats = (body.stats as Record<string, unknown>) ?? {};
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: (body.startedAt as string) ?? new Date().toISOString(),
        p_rows_found: Number(stats.listings_found ?? 0),
        p_rows_written: Number(stats.rows_upserted ?? 0),
        p_rows_skipped: Number(stats.targets_skipped ?? 0),
        p_ok: body.ok !== false,
        p_error: (body.error as string) ?? null,
        p_collection_slug: "nba_top_shot",
        p_extra: { ...stats, deactivated, floor: body.floor ?? null },
      });
    } catch (e) {
      console.log(`[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({ ok: true, upserted, deactivated }, { status: 200 });
}
