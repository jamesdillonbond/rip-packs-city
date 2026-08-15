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
//   1c. seed_topshot_recent_base_subedition_targets     — queue unresolved base nfts in the
//       current parallel era (newest 2 series); catches brand-new parallel sets that neither
//       seed above reaches (no sales collision yet + no ::N editions) — the set-263 gap
//   1d. seed_topshot_collision_knot_targets              — queue the OCCUPANTS of collision
//       knots that aren't yet on-chain-resolved, so step 2 resolves their subedition; the
//       knot resolver (step 6) can then permute them on a later tick
//   2.  trigger the backfill-topshot-subeditions edge fn — resolve subedition on-chain
//   3.  catalog_topshot_subedition_editions_from_resolved — create base::subID editions
//   4.  remap_topshot_split_resolved_subeditions        — split sales/wmc/moments off base
//   4b. remap_topshot_realign_miskeyed_subeditions      — re-key ::N mis-keys back onto the
//       on-chain-correct edition (collision-safe); the inverse the split can't do
//   5.  refresh_topshot_conflated_editions_detector_only — re-measure the guard
//   6.  resolve_topshot_subedition_collision_knots       — resolve the collision knots the
//       realign/split SKIP: two moments transposed onto each other's (edition,serial) slot,
//       where neither can move until the other does. Once BOTH are on-chain-resolved (via the
//       1d seed + step 2), apply the bounded 2-move permutation (≤100/run). ⚠ The old "≤5/run,
//       these surface at ~1/day" was wrong on both halves and cost months: measured 2026-07-31
//       there were 1,441 candidates queued and blocked nfts arriving at ~+8.3/night, so a
//       5/run cap made the backlog DIVERGENT. Keep this limit above the arrival rate.
// Steps 3–4 process what step 2 resolved on PRIOR ticks; the guard converges to 0
// over successive runs. All work is bounded/chunked so a tick fits maxDuration.
//
// Auth: Bearer RPC_ADMIN_TOKEN | INGEST_SECRET_TOKEN | CRON_SECRET, or ?token=.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

// Raised 300 -> 600 (deep-audit D6). This route went DARK for 9 days: it 504'd
// at its 300s ceiling and, because it only wrote pipeline_runs at the very END,
// a killed tick recorded NOTHING — so detect_stalled_pipelines() saw no failure
// and pipeline_runs_daily simply stopped at 2026-07-31. The route's own header
// claims "all work is bounded/chunked so a tick fits maxDuration"; measured, it
// does not. 600 is well inside the Pro 800s cap. Every step is idempotent and
// cursor-driven, so a longer tick is safe and a re-run is free.
export const maxDuration = 600;
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
  // In the Next app runtime the Supabase URL is NEXT_PUBLIC_SUPABASE_URL; the bare
  // SUPABASE_URL only exists inside the edge-fn runtime (not Vercel). Prefer the
  // public var, fall back to the bare name for safety. (Reading only SUPABASE_URL
  // here made this step return "skipped:no_env" on every Vercel tick.)
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
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

  // Start marker (deep-audit D6). The completion row below is written only if we
  // reach the end, so a maxDuration kill used to leave NO trace at all — the
  // failure mode that hid this route being dead for 9 days. Claim a row up front
  // and update it in place: one row per tick either way, and a tick that never
  // finishes stays ok=false with phase="started", which IS the alarm.
  let runId: number | string | null = null;
  try {
    const { data: startRow } = await sb
      .from("pipeline_runs")
      .insert({
        pipeline: PIPELINE,
        collection_slug: COLLECTION_SLUG,
        started_at: new Date(startedAt).toISOString(),
        // ⚠ finished_at MUST be set explicitly here, to started_at (2026-08-15).
        // `pipeline_runs.duration_ms` is GENERATED ALWAYS AS
        // (finished_at - started_at) and `finished_at` DEFAULTS TO now(), so a
        // marker that omits it publishes the latency of its OWN INSERT as the
        // run's duration. These rows read 147/176/185 ms — and a deep audit
        // took exactly that at face value, concluding the route "writes only
        // the start marker (duration_ms 147-176 ms)" and was dying instantly.
        // It is not: the route runs to its 300s maxDuration and is killed, the
        // pre-existing failure mode (313s/257s kills on 2026-07-28/29). Pinning
        // finished_at = started_at makes duration_ms 0 — an obvious sentinel
        // that cannot be mistaken for a measurement of the run, which is the
        // whole point of the marker. The real elapsed is written by the
        // completion update below, and only a run that COMPLETED has one.
        finished_at: new Date(startedAt).toISOString(),
        ok: false,
        error: "started (no completion recorded — killed at maxDuration?)",
        extra: { phase: "started" },
      })
      .select("id")
      .single();
    runId = startRow?.id ?? null;
  } catch {
    // Telemetry must never block the drain.
  }

  // Per-step wall-clock, surfaced in pipeline_runs.extra.step_ms. This route runs
  // close to its 300s maxDuration (313s/257s timeouts on 2026-07-28/29) and the only
  // signal on a timeout was a single duration_ms for nine steps — so "it timed out"
  // could not be turned into "which step". Additive: marks only, no step is
  // restructured. If a tick nears the ceiling, read step_ms and bound THAT step.
  const stepMs: Record<string, number> = {};
  let stepT = Date.now();
  const mark = (k: string) => { stepMs[k] = Date.now() - stepT; stepT = Date.now(); };

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
    mark("seed_conflated");

    // 1b. Broaden coverage: also queue moments/sales already keyed to a ::N
    // subedition that the on-chain table hasn't resolved yet (their base need not
    // be in the conflation guard — the conflated-only seed above misses these).
    // Without this, a moment mis-keyed onto a ::N on a non-conflated edition never
    // gets on-chain-resolved and its wrong circulation never self-heals.
    const { data: seededMis, error: smErr } = await sb.rpc("seed_topshot_miskeyed_subedition_targets", { p_limit: 5000 });
    if (smErr) out.seed_miskeyed_error = smErr.message; else out.seeded_miskeyed = seededMis;
    mark("seed_miskeyed");

    // 1c. Proactively queue unresolved base nfts in the CURRENT parallel era (auto: newest 2
    // TS series). Closes the set-263 class of gap: a brand-new parallel set satisfies neither
    // seed above (no sales collision surfaced yet + no ::N editions exist), so it would never
    // get resolved on-chain and its parallels stay conflated onto base. This reaches every
    // current/new set without waiting for a collision; bounded + self-terminating.
    const { data: seededRecent, error: srErr } = await sb.rpc("seed_topshot_recent_base_subedition_targets", { p_limit: 15000 });
    if (srErr) out.seed_recent_error = srErr.message; else out.seeded_recent = seededRecent;
    mark("seed_recent");

    // 1d. Queue the OCCUPANTS of collision knots that aren't on-chain-resolved yet.
    // A knot is two moments transposed onto each other's (edition,serial) slot; the
    // realign/split (4b/4) SKIP them because the target slot is held by the other nft.
    // Where the occupant's subedition is UNKNOWN, seed it so step 2 resolves it
    // on-chain and step 6 can permute on a later tick.
    //
    // ⚠ This is NOT the throughput gate for step 6, despite the ordering. Measured
    // 2026-07-31 over the 853 then-blocked nfts: the occupant already had a RESOLVED
    // subedition row in 841 (98.6%), so this seeder correctly skips them via its
    // NOT EXISTS gate and step 6 handles them directly — it derives its own
    // candidates and does not read this queue. Only ~12 were the unknown-occupant
    // case this seeder exists for. Its other two gates (occupant nft_id numeric,
    // occupant base int-keyed) excluded ZERO. So widening this predicate does not
    // move the blocked count; step 6's p_limit does.
    const { data: seededKnots, error: skErr } = await sb.rpc("seed_topshot_collision_knot_targets", { p_limit: 200 });
    if (skErr) out.seed_knot_error = skErr.message; else out.seeded_knot_occupants = seededKnots;
    mark("seed_knot_occupants");

    // 2. Kick the on-chain subedition resolver for the pending queue.
    out.subedition_backfill_trigger = await triggerSubeditionBackfill();
    mark("onchain_resolve_trigger");

    // 3. Catalog base::subID editions for everything resolved so far.
    const { data: cataloged, error: cErr } = await sb.rpc(
      "catalog_topshot_subedition_editions_from_resolved", { p_limit: 1000 });
    if (cErr) out.catalog_error = cErr.message; else out.cataloged = cataloged;
    mark("catalog");

    // 4. Split resolved parallels off the base onto their ::subID editions.
    const { data: split, error: sErr } = await sb.rpc(
      "remap_topshot_split_resolved_subeditions", { p_limit: 8000 });
    if (sErr) out.split_error = sErr.message; else out.split = split;
    mark("split");

    // 4b. Inverse/cross realign — the direction the split can't do: re-key
    // moments/sales/wmc that are mis-keyed ONTO a ::N (on-chain says Standard or a
    // DIFFERENT parallel) back onto the correct edition. Collision-safe: a target
    // serial already held by another nft is a conflation knot, left for the
    // getMintedMoment path. Fixes the wrong-circulation moment-page display.
    const { data: realign, error: rErr } = await sb.rpc(
      "remap_topshot_realign_miskeyed_subeditions", { p_limit: 8000 });
    if (rErr) out.realign_error = rErr.message; else out.realign = realign;
    mark("realign");

    // 5. Re-measure the conflation guard.
    const { data: guard, error: gErr } = await sb.rpc("refresh_topshot_conflated_editions_detector_only");
    if (gErr) out.guard_error = gErr.message; else out.conflated_editions_remaining = guard;
    mark("conflation_guard");

    // 6. Resolve collision knots the realign/split can't (two moments transposed
    // onto each other's slot). Only acts on knots where BOTH nfts are
    // on-chain-resolved and both target editions exist — everything else waits
    // for a later tick. Serials preserved; every move logged to
    // topshot_collision_knot_resolutions.
    //
    // p_limit was 5 from 2026-07-06 (deliberately conservative while the in-place
    // permutation was new). Raised to 100 on 2026-07-31 because 5 is BELOW the
    // arrival rate, which made the blocked queue provably divergent rather than
    // merely slow: realign.collisions_skipped grew 833→840→849→858 over the four
    // retained runs (+8.3/night, monotonic) while this step cleared exactly 5.
    // Measured at the time: 1,441 knot candidates available, so the old cap needed
    // ~288 nights for a pool that was still growing.
    //
    // NOTE the LIMIT binds _knot_cand SELECTION, before the loop — so "resolved 5,
    // skipped 0" meant the cap bound selection at 5 and the defensive re-check
    // rejected none of those 5. It did NOT mean the resolver was uncapped and
    // starved of input by the step-1d seeder (that seeder feeds the on-chain
    // resolve path; this step derives its own candidates from moments +
    // topshot_moment_subeditions directly, and is not gated by it).
    //
    // Cost basis for 100 (this route runs near its 300s maxDuration — 313s/257s
    // timeouts on 07-28/29, 171s/201s since): candidate selection is a FIXED ~1.83s
    // regardless of p_limit (dominated by parallel seq scans over moments ~292k and
    // topshot_moment_subeditions ~352k), and each knot is ~15 indexed single-row
    // statements, so 100 adds only a few seconds. Raise further only after
    // confirming duration_ms still has headroom.
    const { data: knots, error: kErr } = await sb.rpc("resolve_topshot_subedition_collision_knots", { p_limit: 100 });
    if (kErr) out.knot_resolve_error = kErr.message; else out.knots = knots;
    mark("knots");
  } catch (err) {
    out.fatal = err instanceof Error ? err.message : String(err);
  }

  out.step_ms = stepMs;
  const ok = !out.fatal && !out.seed_error && !out.seed_miskeyed_error && !out.seed_recent_error && !out.seed_knot_error && !out.catalog_error && !out.split_error && !out.realign_error && !out.guard_error && !out.knot_resolve_error;
  out.duration_ms = Date.now() - startedAt;

  const finishedRow = {
      pipeline: PIPELINE,
      collection_slug: COLLECTION_SLUG,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      rows_found: Number(out.seeded ?? 0),
      rows_written: Number((out.split as any)?.sales_split ?? 0) + Number((out.split as any)?.wmc_split ?? 0),
      rows_skipped: 0,
      ok,
      error: (out.fatal ?? out.seed_error ?? out.seed_miskeyed_error ?? out.seed_recent_error ?? out.seed_knot_error ?? out.catalog_error ?? out.split_error ?? out.realign_error ?? out.guard_error ?? out.knot_resolve_error ?? null) as string | null,
      extra: out,
  };
  try {
    // Update the marker when we have one; fall back to an insert if the marker
    // write failed, so a telemetry hiccup cannot lose the run entirely.
    if (runId != null) {
      await sb.from("pipeline_runs").update(finishedRow).eq("id", runId);
    } else {
      await sb.from("pipeline_runs").insert(finishedRow);
    }
  } catch { /* best-effort */ }

  return NextResponse.json({ ok, pipeline: PIPELINE, ...out });
}

export async function GET(req: NextRequest): Promise<NextResponse> { return handle(req); }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req); }
