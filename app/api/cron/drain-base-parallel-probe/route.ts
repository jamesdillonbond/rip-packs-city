// app/api/cron/drain-base-parallel-probe/route.ts
//
// Vercel cron trigger for the Population B base-resident parallel probe (2026-07-05).
// The heavy work runs in the Supabase edge fn backfill-topshot-base-parallel-probe
// (on-chain TopShot.getMomentsSubedition over the ~134k-row
// topshot_base_parallel_probe_queue, cursor-resumable). This route only fires that
// edge fn with the server-side INGEST bearer so the secret never appears in any
// cron dashboard — the same pattern as /api/admin/drain-topshot-misattribution.
//
// Why a Vercel cron and not cron-job.org: the edge fn needs the INGEST bearer, which
// on cron-job.org lives on the Advanced tab (secret — operator-only, do not open) and
// cannot be passed as ?token= (leaks into cron history). A Vercel cron injects the
// secret server-side here instead. Runs every 15 min (staggered) until the queue
// drains (~7 ticks at batch_size 20000), then each tick is a fast done=true no-op.
//
// Auth: Bearer CRON_SECRET (Vercel cron) | INGEST_SECRET_TOKEN | RPC_ADMIN_TOKEN, or ?token=.

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const EDGE_FN = "backfill-topshot-base-parallel-probe";
const BATCH_SIZE = 20000;

function authed(req: NextRequest): boolean {
  if (verifyAdminRequest(req)) return true;
  const hdr = req.headers.get("authorization") ?? "";
  const q = req.nextUrl.searchParams.get("token") ?? "";
  for (const t of [process.env.CRON_SECRET, process.env.INGEST_SECRET_TOKEN, process.env.RPC_ADMIN_TOKEN]) {
    if (t && (hdr === `Bearer ${t}` || q === t)) return true;
  }
  return false;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authed(req)) return adminUnauthorizedResponse();

  // In the Next app runtime the Supabase URL is NEXT_PUBLIC_SUPABASE_URL; the bare
  // SUPABASE_URL only exists inside the edge-fn runtime (not Vercel). Prefer the
  // public var, fall back to the bare name for safety.
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const token = process.env.INGEST_SECRET_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ ok: false, error: "missing NEXT_PUBLIC_SUPABASE_URL or INGEST_SECRET_TOKEN" }, { status: 500 });
  }

  let trigger = "";
  try {
    const res = await fetch(`${base}/functions/v1/${EDGE_FN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ batch_size: BATCH_SIZE }),
      signal: AbortSignal.timeout(20000),
    });
    trigger = `${res.status}`;
  } catch (err) {
    trigger = `err:${err instanceof Error ? err.message.slice(0, 120) : "x"}`;
  }

  return NextResponse.json({
    ok: trigger === "202" || trigger === "200",
    edge_fn: EDGE_FN,
    trigger,
    note: "Work + results land in pipeline_runs as pipeline=topshot-base-parallel-probe within ~30s.",
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> { return handle(req); }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req); }
