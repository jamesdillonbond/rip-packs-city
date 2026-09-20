import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat";

// Refreshes public.topshot_conflated_editions — the interim parallel-conflation
// guard (handoff-2026-06-20-parallel-conflation-phase0-verified). TopShot
// SubEditions share setID:playID and each numbers serials 1..N independently, so
// a single editions row blends parallels' prices -> inflated FMV -> fake "deals".
// The table flags editions where 2+ distinct nft_ids share a serial; the deal
// board (topshot_deals_vs_fmv) excludes them, suppressing fake deals + alerts
// until the subedition re-key lands. The set is slow-moving, so a daily refresh
// is ample. Operator: wire a daily cron-job.org entry with Bearer INGEST_SECRET_TOKEN.
// Pattern mirrors /api/cron/refresh-special-serial-owners-mv.
//
// Also refreshes the sibling deal-board guard topshot_thin_fmv_editions (the thin-data
// FMV flag, audit_20260621_topshot_thin_fmv_deal_flag).
//
// ⚠ THAT SENTENCE USED TO END "so wiring this one cron keeps BOTH honesty guards
// current", and on 2026-09-20 that was measurably false: the table held 7 rows all
// stamped 09-18 01:30 PT, 57.9 h stale, because this route was killed at its 120 s
// wall on 09-19 and 09-20 AND pg_cron job 63 (`rpc-refresh-thin-fmv-guard`, the
// independent daily backstop) timed out at ~604 s on the same two days. This route
// is ONE of two writers and neither is guaranteed; see the LANE PROVENANCE note in
// the body for why every counter here now carries its provenance.

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const PIPELINE_NAME = "refresh-conflated-editions";

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  // 202 + after(): the detector aggregates 365d of TS sales (can exceed
  // cron-job.org's 30s client cap), so auth stays sync, the refresh + log move
  // into after(), and we return immediately so the entry is never auto-disabled
  // on a timeout. pipeline_runs is the real signal.
  after(async () => {
    // Invocation heartbeat, written BEFORE the work and awaited.
    //
    // ⚠ `try/catch` CANNOT catch a `maxDuration` kill: the platform terminates
    // the function and takes the terminal row with it, while the 202 above has
    // already told cron-job.org this succeeded. The comment above explains the
    // 202 exists so the cron entry is "never auto-disabled on a timeout" — that
    // protects the SCHEDULE and does nothing for the observability, which is
    // what this marker is for.
    //
    // ⭐ SELECTED ON MEASURED MARGIN: this route aggregates 365 days of Top Shot
    // sales, and over the 73 h retained (read 2026-09-02) its 3 recorded ticks
    // run **77,621 ms at p90 and 79,059 ms at maximum — 66% of the 120,000 ms
    // wall.** It is a daily job, so three samples are the whole population
    // available, and all three sit two thirds of the way to the ceiling.
    //
    // ⚠ The db argument is explicit because this route builds its OWN client
    // rather than importing `lib/supabase`.
    await writeInvocationHeartbeat(
      { pipeline: PIPELINE_NAME, startedAtMs: Date.parse(startedAt) },
      supabaseAdmin,
    );
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    let flagged = 0;

    // ── LANE PROVENANCE (2026-09-20) ────────────────────────────────────────
    // 🚨 MEASURED, not hypothesised. `topshot_thin_fmv_editions` — the deal
    // board's thin-data caveat set, which alerts also suppress on — was read at
    // 11:2x AM PT holding 7 rows, EVERY ONE stamped 2026-09-18 01:30 PT: 57.9
    // hours stale. Both of its writers were down at once:
    //   * this route, killed at the 120 s wall on 09-19 and 09-20 (heartbeat
    //     rows, no terminal row);
    //   * pg_cron job 63 `rpc-refresh-thin-fmv-guard`, FAILED on 09-19 and
    //     09-20 with `canceling statement due to statement timeout` at ~604 s.
    // Nothing paged: no `check_*` invariant names this table, and a pg_cron
    // failure shows only in `cron.job_run_details`, never in `pipeline_runs`.
    //
    // ⛔ AND WHEN THIS ROUTE *DID* COMPLETE, IT REPORTED THE OUTAGE AS A ZERO.
    // All three sweeps below are deliberately non-fatal, and each one swallowed
    // its error into a `console.log` while its counter stayed at its `0`
    // initialiser — so `thin_fmv_flagged: 0` in `extra` read exactly like "ran
    // fine, nothing to flag", and `p_ok` stayed TRUE. That is CLAUDE.md's named
    // worst sub-class, a SWEEP whose `ok` means it COMPLETED, not that its LANES
    // worked, sitting on top of the fabricated-value shape.
    //
    // ⚠ So every non-fatal counter starts `null` (UNKNOWN) rather than `0`
    // (MEASURED), each lane records its error, and `p_ok` is false when any lane
    // failed. Non-fatal still means non-fatal: a thin-FMV failure must not stop
    // the conflation refresh. It must only stop it being reported as a success.
    //
    // ⚠ The two remap sweeps are counted SEPARATELY and summed only when BOTH
    // succeeded — a partial sum persisted as `sales_remapped` would be a PARTIAL
    // READ published as the fact.
    let remapBaseToParallel: number | null = null;
    let remapParallelToBase: number | null = null;
    let thinFmvFlagged: number | null = null;
    const laneErrors: Record<string, string> = {};
    try {
      // Sweep first: redirect any base-keyed sale whose nft is a known parallel
      // onto its `::subID` edition. This is the durable "periodic historical-remap
      // re-run" (handoff-2026-06-20-conflation-drift-history-backfill-leak) — it
      // catches sub-sales that landed on the base before their nft was resolved in
      // topshot_moment_subeditions, so conflation converges instead of drifting up.
      // Non-fatal: a remap failure must not block the guard refresh below.
      try {
        const rm = await supabaseAdmin.rpc("remap_topshot_base_keyed_parallel_sales");
        if (rm.error) {
          laneErrors.remap_base_to_parallel = rm.error.message;
          console.log(`[${PIPELINE_NAME}] remap rpc err: ${rm.error.message}`);
        } else if (rm.data == null) {
          // A SECURITY DEFINER `RETURNS integer` that hands back no row is not a
          // zero — it is an unread result, and `?? 0` is how it used to become one.
          laneErrors.remap_base_to_parallel = "rpc returned no row count";
        } else {
          remapBaseToParallel = Number(rm.data);
        }
      } catch (e) {
        laneErrors.remap_base_to_parallel = e instanceof Error ? e.message : String(e);
        console.log(`[${PIPELINE_NAME}] remap rpc threw: ${laneErrors.remap_base_to_parallel}`);
      }

      // Reverse sweep: re-key any sale mis-attributed ONTO a `::` parallel back to
      // base when the on-chain subedition map proves it's Standard (or an
      // impossible serial > parallel circulation). Complements the base->parallel
      // remap above; together they converge the leak found 2026-07-01 (Item 1,
      // GQL parallelID false-positived Standard moments onto S8 ::16/::18 parallels).
      // Non-fatal.
      try {
        const rmr = await supabaseAdmin.rpc("remap_topshot_parallel_to_base_misattributed");
        if (rmr.error) {
          laneErrors.remap_parallel_to_base = rmr.error.message;
          console.log(`[${PIPELINE_NAME}] parallel->base remap err: ${rmr.error.message}`);
        } else if (rmr.data == null) {
          laneErrors.remap_parallel_to_base = "rpc returned no row count";
        } else {
          remapParallelToBase = Number(rmr.data);
        }
      } catch (e) {
        laneErrors.remap_parallel_to_base = e instanceof Error ? e.message : String(e);
        console.log(`[${PIPELINE_NAME}] parallel->base remap threw: ${laneErrors.remap_parallel_to_base}`);
      }

      const res = await supabaseAdmin.rpc("refresh_topshot_conflated_editions");
      if (res.error) {
        ok = false;
        errMsg = res.error.message;
      } else {
        flagged = Number(res.data ?? 0);
      }

      // Sibling deal-board honesty guard: refresh the thin-data FMV flag set
      // (topshot_thin_fmv_editions, audit_20260621_topshot_thin_fmv_deal_flag).
      // FLAGS (not suppresses) editions whose WAP/mean FMV overshoots the 90d
      // median on <15 sales/90d -> the deal board renders a "thin data" caveat
      // and alerts skip them. Co-located here so the same daily refresh keeps both
      // guards current. Non-fatal: a thin-FMV failure must not fail the conflation
      // refresh or its pipeline_runs signal.
      try {
        const tf = await supabaseAdmin.rpc("refresh_topshot_thin_fmv_editions");
        if (tf.error) {
          laneErrors.thin_fmv = tf.error.message;
          console.log(`[${PIPELINE_NAME}] thin-fmv rpc err: ${tf.error.message}`);
        } else if (tf.data == null) {
          laneErrors.thin_fmv = "rpc returned no row count";
        } else {
          thinFmvFlagged = Number(tf.data);
        }
      } catch (e) {
        laneErrors.thin_fmv = e instanceof Error ? e.message : String(e);
        console.log(`[${PIPELINE_NAME}] thin-fmv rpc threw: ${laneErrors.thin_fmv}`);
      }
    } catch (e) {
      ok = false;
      errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[${PIPELINE_NAME}] refresh rpc threw: ${errMsg}`);
    }

    // ⚠ Summed ONLY when both sweeps succeeded: a partial sum published as
    // `sales_remapped` is a partial read persisted as the fact.
    const remapped =
      remapBaseToParallel === null || remapParallelToBase === null
        ? null
        : remapBaseToParallel + remapParallelToBase;

    // ⭐ `ok` means THE LANES WORKED, not that the body reached its end. The
    // whole reason this route's thin-FMV outage was invisible is that the old
    // `p_ok` answered the second question while every reader asked the first.
    const lanesFailed = Object.keys(laneErrors).sort();
    const finalOk = ok && lanesFailed.length === 0;
    const laneSummary = lanesFailed.map((n) => `${n}: ${laneErrors[n]}`).join(" | ");
    const finalError = errMsg ?? (laneSummary ? `lane(s) failed — ${laneSummary}` : null);

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: flagged,
        p_rows_written: flagged,
        p_rows_skipped: 0,
        p_ok: finalOk,
        p_error: finalError,
        p_extra: {
          duration_ms: Date.now() - startedMs,
          flagged_editions: flagged,
          // ⚠ null = the lane did not report, NEVER 0 = the lane reported none.
          sales_remapped: remapped,
          remap_base_to_parallel: remapBaseToParallel,
          remap_parallel_to_base: remapParallelToBase,
          thin_fmv_flagged: thinFmvFlagged,
          lanes_failed: lanesFailed,
          lane_errors: laneErrors,
        },
      });
    } catch (logErr) {
      console.log(
        `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      );
    }
  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: PIPELINE_NAME },
    { status: 202 }
  );
}

export async function POST(request: NextRequest) {
  return run(request);
}

export async function GET(request: NextRequest) {
  return run(request);
}
