// app/api/admin/drain-conflated-subeditions/route.ts
//
// F9 orchestrator (2026-07-04) — drains the standing `topshot_conflated_editions`
// guard (546 editions), whose shared-serial collisions are ~100% the
// SUBEDITION-SPLIT class: parallel moments (Club Collection ::16 /99, Blockchain
// ::17, Hardcourt ::18, Voltage ::13, …) keyed to the BASE setID:playID, so a
// Standard #N and a Club #N collide. The GQL misattrib-drain can't fix this —
// getMintedMoment returns setID:playID:serial but NOT the subedition. The only
// subedition source is on-chain TopShot.getMomentsSubedition (the
// `backfill-topshot-subeditions` edge fn), which only resolves nfts already
// SEEDED in topshot_moment_subeditions.
//
// This route ties the pipeline together, idempotently, per tick:
//   1.  seed_topshot_conflated_subedition_targets      — queue conflated moments
//   1b. seed_topshot_miskeyed_subedition_targets        — queue ::N-keyed unresolved moments
//   2.  trigger the backfill-topshot-subeditions edge fn — resolve subedition on-chain
//   3.  catalog_topshot_subedition_editions_from_resolved — create base::subID editions
//   4.  remap_topshot_split_resolved_subeditions        — split sales/wmc/moments off base
//   4b. remap_topshot_realign_miskeyed_subeditions      — re-key ::N mis-keys back onto the
//       on-chain-correct edition (collision-safe); the inverse the split can't do
//   5.  refresh_topshot_conflated_editions_detector_only — re-measure the guard
// Steps 3–4 process what step 2 resolved on PRIOR ticks; the guard converges to 0
// over successive runs. All work is bounded/chunked so a tick fits maxDuration.
//
// Auth: Bearer RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN | CRON_SECRET, or ?token=.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const PIPELINE = "drain-conflated-subeditions";
const COLLECTION_SLUG = "nba-top-shot";
const SEED_ROUNDS = 4;          // editions batches to seed per tick
const SEED_EDITIONS_PER_ROUND = 60;

function authed(req: NextRequest): boolean {
  if (verifyAdminRequest(req)) return true;
  const hdr = req.headers.get("authorization") ?? "";
  const q = req.nextUrl.searchParams.get("token") ?? "";
  for (const t of [process.env.INGEST_SECRET_TOKEN, process.env.CRON_SECRET, process.env.RPC_ADMIN_TOKEN]) {
    if (t && (hdr === `Bearer ${t}` || q === t)) return true;
  }
  return false;
}

// Fire the on-chain subedition resolver (Supabase edge fn). Fire-and-forget: it
// drains pending targets via getMomentsSubedition under its own EdgeRuntime budget.
async function triggerSubeditionBackfill(): Promise<string> {
  const base = process.env.SUPABASE_URL;
  const token = process.env.INGEST_SECRET_TOKEN;
  if (!base || !token) return "skipped:no_env";
  try {
    const res = await fetch(`${base}/functions/v1/backfill-topshot-subeditions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ batch_size: 20000 }),
      signal: AbortSignal.timeout(20000),
    });
    return `${res.status}`;
  } catch (err) {
    return `err:${err instanceof Error ? err.message.slice(0, 80) : "x"}`;
  }
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authed(req)) return adminUnauthorizedResponse();
  const startedAt = Date.now();
  const sb: any = supabaseAdmin;
  const out: Record<string, unknown> = {};

  try {
    // 1. Seed conflated-edition moments as pending subedition targets (advance across editions).
    let seeded = 0;
    for (let i = 0; i < SEED_ROUNDS; i++) {
      const { data, error } = await sb.rpc("seed_topshot_conflated_subedition_targets", {
        p_max_editions: SEED_EDITIONS_PER_ROUND,
      });
      if (error) { out.seed_error = error.message; break; }
      const got = typeof data === "number" ? data : 0;
      seeded += got;
      if (got === 0) break; // all editions seeded
    }
    out.seeded = seeded;

    // 1b. Broaden coverage: also queue moments/sales already keyed to a ::N
    // subedition that the on-chain table hasn't resolved yet (their base need not
    // be in the conflation guard — the conflated-only seed above misses these).
    // Without this, a moment mis-keyed onto a ::N on a non-conflated edition never
    // gets on-chain-resolved and its wrong circulation never self-heals.
    const { data: seededMis, error: smErr } = await sb.rpc("seed_topshot_miskeyed_subedition_targets", { p_limit: 5000 });
    if (smErr) out.seed_miskeyed_error = smErr.message; else out.seeded_miskeyed = seededMis;

    // 2. Kick the on-chain subedition resolver for the pending queue.
    out.subedition_backfill_trigger = await triggerSubeditionBackfill();

    // 3. Catalog base::subID editions for everything resolved so far.
    const { data: cataloged, error: cErr } = await sb.rpc(
      "catalog_topshot_subedition_editions_from_resolved", { p_limit: 1000 });
    if (cErr) out.catalog_error = cErr.message; else out.cataloged = cataloged;

    // 4. Split resolved parallels off the base onto their ::subID editions.
    const { data: split, error: sErr } = await sb.rpc(
      "remap_topshot_split_resolved_subeditions", { p_limit: 8000 });
    if (sErr) out.split_error = sErr.message; else out.split = split;

    // 4b. Inverse/cross realign — the direction the split can't do: re-key
    // moments/sales/wmc that are mis-keyed ONTO a ::N (on-chain says Standard or a
    // DIFFERENT parallel) back onto the correct edition. Collision-safe: a target
    // serial already held by another nft is a conflation knot, left for the
    // getMintedMoment path. Fixes the wrong-circulation moment-page display.
    const { data: realign, error: rErr } = await sb.rpc(
      "remap_topshot_realign_miskeyed_subeditions", { p_limit: 8000 });
    if (rErr) out.realign_error = rErr.message; else out.realign = realign;

    // 5. Re-measure the conflation guard.
    const { data: guard, error: gErr } = await sb.rpc("refresh_topshot_conflated_editions_detector_only");
    if (gErr) out.guard_error = gErr.message; else out.conflated_editions_remaining = guard;
  } catch (err) {
    out.fatal = err instanceof Error ? err.message : String(err);
  }

  const ok = !out.fatal && !out.seed_error && !out.seed_miskeyed_error && !out.catalog_error && !out.split_error && !out.realign_error && !out.guard_error;
  out.duration_ms = Date.now() - startedAt;

  try {
    await sb.from("pipeline_runs").insert({
      pipeline: PIPELINE,
      collection_slug: COLLECTION_SLUG,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      rows_found: Number(out.seeded ?? 0),
      rows_written: Number((out.split as any)?.sales_split ?? 0) + Number((out.split as any)?.wmc_split ?? 0),
      rows_skipped: 0,
      ok,
      error: (out.fatal ?? out.seed_error ?? out.seed_miskeyed_error ?? out.catalog_error ?? out.split_error ?? out.realign_error ?? out.guard_error ?? null) as string | null,
      extra: out,
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok, pipeline: PIPELINE, ...out });
}

export async function GET(req: NextRequest): Promise<NextResponse> { return handle(req); }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req); }
