// app/api/cron/alerts-dispatch/route.ts
//
// Dispatcher cron. Scans active deal subscriptions + triggered per-edition FMV
// alerts and enqueues alert_deliveries rows (deduped) for each linked+verified
// channel. The per-channel senders (alerts-send) then drain the outbox.
//
// Auth: Bearer ${INGEST_SECRET_TOKEN} or ${CRON_SECRET}.
// Cron-job.org: every ~15 min, off the :00 rush, www domain.

// 120s so the lambda outlives the deal-dispatch RPC's 90s statement_timeout
// (raised from 45s once the board grew a 3rd leg — NFL All Day — and the
// tmp_deal_pool materialization got heavier). Well under the 800s Pro cap.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { dispatchDueDealAlerts, dispatchTriggeredFmvAlerts } from "@/lib/alerts";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
) as any;

const PIPELINE_NAME = "alerts-dispatch";

// dispatch_due_deal_alerts' verdict keys → the pipeline_runs.extra keys they
// are logged under. The `unconfirmed_*` names predate the pool sizes and are
// kept, since readers already key on them.
const DEAL_VERDICT_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["subscriptions_scanned", "subscriptions_scanned"],
  ["serial_enqueued", "enqueued_serial"],
  ["deal_pool_size", "pool_deal"],
  ["price_pool_size", "pool_price"],
  ["serial_pool_size", "pool_serial"],
  ["deal_pool_unconfirmed", "unconfirmed_deal"],
  ["price_pool_unconfirmed", "unconfirmed_price"],
  ["serial_pool_unconfirmed", "unconfirmed_serial"],
];

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  return (
    auth === `Bearer ${process.env.INGEST_SECRET_TOKEN}` ||
    auth === `Bearer ${process.env.CRON_SECRET}`
  );
}

async function run(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();

  after(async () => {
    const startedMs = Date.now();
    let ok = true;
    let errMsg: string | null = null;
    let enqueuedDeal = 0;
    let enqueuedFmv = 0;
    // How many candidate rows the freshness gate held back this tick, and how
    // many were in each pool to begin with. Null until a successful deal
    // dispatch reports them — an absent count must not read as a measured zero
    // (audit_20260912).
    //
    // ⚠ THE POOL SIZES ARE THE DENOMINATOR, and without them `unconfirmed_serial: 0`
    // is ambiguous: `count(*) FILTER (WHERE NOT alertable)` over an EMPTY pool is
    // also 0. The RPC has always returned `*_pool_size`; this route dropped it, so
    // telling "the gate held nothing back" from "there was nothing to gate" took a
    // hand query against the board (inbox 2026-09-23T0155Z). A key the RPC did not
    // return is OMITTED, never defaulted to 0.
    let dealVerdict: Record<string, number | string> | null = null;

    try {
      const deal = await dispatchDueDealAlerts(1000);
      if ("error" in deal) {
        ok = false;
        errMsg = `deal: ${deal.error}`;
      } else {
        enqueuedDeal = deal.enqueued ?? 0;
        dealVerdict = {};
        for (const [from, to] of DEAL_VERDICT_KEYS) {
          const v = (deal as Record<string, unknown>)[from];
          if (typeof v === "number" && Number.isFinite(v)) dealVerdict[to] = v;
        }
        // The RPC's early return for "no active subscriptions" reports every pool
        // as 0 without building one. Carry its reason so those zeros are read as
        // NOT MEASURED rather than as empty pools.
        if (typeof deal.skipped === "string") dealVerdict.deal_skipped = deal.skipped;
      }
    } catch (e) {
      ok = false;
      errMsg = `deal threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      const fmv = await dispatchTriggeredFmvAlerts(200);
      if ("error" in fmv) {
        ok = false;
        errMsg = `${errMsg ? errMsg + "; " : ""}fmv: ${fmv.error}`;
      } else {
        enqueuedFmv = fmv.enqueued ?? 0;
      }
    } catch (e) {
      ok = false;
      errMsg = `${errMsg ? errMsg + "; " : ""}fmv threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    try {
      // supabase-js RESOLVES with { error } rather than throwing, so an
      // un-destructured await dropped a failed log write without a trace.
      const { error: logError } = await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: enqueuedDeal + enqueuedFmv,
        p_rows_written: enqueuedDeal + enqueuedFmv,
        p_rows_skipped: 0,
        p_ok: ok,
        p_error: errMsg,
        p_extra: {
          enqueued_deal: enqueuedDeal,
          enqueued_fmv: enqueuedFmv,
          // Spread, so a run that never got a verdict carries NO key rather than
          // zeroes that read as "nothing was suppressed".
          ...(dealVerdict ?? {}),
          duration_ms: Date.now() - startedMs,
        },
      });
      if (logError) {
        console.error(`[${PIPELINE_NAME}] log_pipeline_run error: ${logError.message}`);
      }
    } catch (logErr) {
      console.log(
        `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      );
    }
  });

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
