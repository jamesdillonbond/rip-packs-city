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

    try {
      const deal = await dispatchDueDealAlerts(1000);
      if ("error" in deal) {
        ok = false;
        errMsg = `deal: ${deal.error}`;
      } else {
        enqueuedDeal = deal.enqueued ?? 0;
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
      await supabaseAdmin.rpc("log_pipeline_run", {
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
          duration_ms: Date.now() - startedMs,
        },
      });
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
