import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PIPELINE_NAME = "backfill-pack-rip-metadata";

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  // 202 + after(): the backfill RPC can exceed cron-job.org's 30s client cap
  // under DB saturation; auth stays sync, the work + log_pipeline_run move
  // into after(), and we return immediately so the entry can never be
  // auto-disabled on a timeout. pipeline_runs is the real success signal.
  after(async () => {
    const startedMs = Date.now();
    // 2026-06-11: the backfill RPC call previously sat OUTSIDE this try/catch, so
    // when it THREW (connection-pool timeout under DB saturation — not a returned
    // error) the after() rejected before log_pipeline_run and the run went silent
    // while cron-job.org acked green (the 06-10 15:53→01:53Z dark window). Every
    // exit path must log: capture both the returned-error and thrown cases.
    let ok = true;
    let errMsg: string | null = null;
    let data: any = null;
    try {
      const res = await supabaseAdmin.rpc("backfill_pack_rip_metadata", {
        p_limit: 500,
      });
      if (res.error) {
        ok = false;
        errMsg = res.error.message;
      } else {
        data = res.data;
      }
    } catch (e) {
      ok = false;
      errMsg = e instanceof Error ? e.message : String(e);
      console.log(`[${PIPELINE_NAME}] backfill rpc threw: ${errMsg}`);
    }

    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: Number(data?.processed ?? 0),
        p_rows_written: Number(data?.value_resolved ?? 0),
        p_rows_skipped: 0,
        p_ok: ok,
        p_error: errMsg,
        p_extra: {
          // 2026-09-12: `dist_resolved` is RETIRED, not renamed. It came from
          // `RETURNING pr.dist_id IS NOT NULL` over an UPDATE that COALESCEs the
          // existing value, so it counted every row that ENDED UP with a dist_id
          // — including the ones that walked in with one — and read 484/484/488
          // of 500 on three consecutive runs while the outcome table did not
          // move. A key that DISAPPEARS tells a reader the definition changed;
          // a key that stays and means something new does not. See #72 and
          // migration 20260912152337. The three fields sum to `processed`.
          dist_newly_resolved: data?.dist_newly_resolved ?? null,
          dist_already_set: data?.dist_already_set ?? null,
          dist_still_null: data?.dist_still_null ?? null,
          value_resolved: data?.value_resolved ?? null,
          // 2026-09-12: how many of this run's rows were priced by the ALL DAY
          // arm (allday_pack_pull, exact join on pack_nft_id) rather than the
          // Top Shot moment_acquisitions path. It is the exit criterion for
          // audit_20260912_pack_rip_pull_value_allday_arm: a steady 0 means the
          // candidates are not reaching that CTE, which is a different failure
          // from "no All Day data" and is otherwise indistinguishable in
          // `value_resolved`.
          // ⚠ It counts PRICED-BY-THAT-ARM, not NEWLY-VALUED. The stale leg
          // re-prices All Day rows through the same source, so this reads
          // 135-217 while the net-new count is the repair leg's cap of 50.
          allday_resolved: data?.allday_resolved ?? null,
          // 2026-09-20: the three counters the zero/unpriced repair legs added
          // (migration 20260920203815, register #128 and #93). They are the ONLY
          // way to watch those two drains from outside the database, and each
          // means rows WRITTEN, not rows looked at:
          //   zero_cleared        a fabricated `pull_value_usd = 0` that could
          //                       not be priced now, set to NULL (honest unknown)
          //   zero_repriced       a fabricated 0 that WAS priceable, replaced
          //                       with the real value -- ~93 % of them at filing,
          //                       so the fabrication was mostly MASKING a value
          //                       we already had
          //   value_newly_written any row that went NULL -> a value this tick
          // ⚠ `zero_cleared + zero_repriced` falling to 0 while
          // `pack_rips.pull_value_usd = 0` still has rows means the leg STOPPED
          // reaching them, which is a different failure from the drain finishing
          // -- and the two are indistinguishable in `value_resolved`, which is
          // exactly the trap the `allday_resolved` note ABOVE this one records.
          // ⛔ `?? null` and not `?? 0`: on an older function body these keys are
          // ABSENT, and a 0 there would read as "the leg ran and found nothing".
          zero_cleared: data?.zero_cleared ?? null,
          zero_repriced: data?.zero_repriced ?? null,
          value_newly_written: data?.value_newly_written ?? null,
          duration_ms: Date.now() - startedMs,
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
