// app/api/cron/topshot-catalog-backfill/route.ts
//
// Scheduler-facing wrapper around /api/admin/backfill-topshot-catalog.
//
// WHY A WRAPPER EXISTS AT ALL. The admin route is guarded by
// `verifyAdminRequest`, which accepts ONLY `RPC_ADMIN_TOKEN`. Vercel cron
// injects `Authorization: Bearer $CRON_SECRET` and nothing else, so a plain
// `vercel.json` entry pointed at the admin route would 401 on EVERY tick —
// and, because a 401 writes no `pipeline_runs` row, it would look exactly like
// "the job was never scheduled". That is the same invisible-failure shape as
// the 2026-08-11 gate-key outage. This route accepts the scheduler's secret,
// then calls the walker in-process.
//
// ⚠ IN-PROCESS, NOT AN HTTP HOP. It imports the admin handler and invokes it
// with a synthesized admin-authorized request rather than fetching its own
// deployment. A self-fetch would need a correct absolute base URL in every
// environment, would burn a second lambda, and would fail closed on preview
// deployments behind SSO — three ways to reintroduce the silent-401 class this
// route exists to remove.
//
// Auth: `Authorization: Bearer $CRON_SECRET` (Vercel cron) or
// `Bearer $INGEST_SECRET_TOKEN` (manual/backstop), mirroring /api/cron/warm.
// The canonical dual-secret pattern — accepting only one of the two is the
// documented footgun that left the insights-cache warmer 401ing for 11 minutes.
//
// The walker logs its own `pipeline_runs` row (pipeline `topshot-catalog-backfill`)
// including `sets_faulted`, so this wrapper deliberately logs nothing itself —
// two rows per tick would double-count the pipeline's run history.
//
// ⚠ READ `editions_upserted`, NOT the HTTP status, when checking a run. The
// walker returns 200 whenever it completes a sweep; a sweep that upserted
// nothing is a 200. Since 2026-08-13 `sets_faulted` makes that self-evident
// (every set faulting also flips `ok` false), but the habit still matters.

import { NextRequest, NextResponse } from "next/server";
import { GET as runCatalogBackfill } from "@/app/api/admin/backfill-topshot-catalog/route";

export const dynamic = "force-dynamic";
// The walker self-bounds at maxDuration - 30s and resumes on the next tick via
// least-recently-touched ordering, so a partial sweep is normal and safe.
export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET;
  const ingest = process.env.INGEST_SECRET_TOKEN;
  return (
    (!!cronSecret && auth === `Bearer ${cronSecret}`) ||
    (!!ingest && auth === `Bearer ${ingest}`)
  );
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const adminToken = process.env.RPC_ADMIN_TOKEN;
  if (!adminToken) {
    // Fail LOUD rather than passing an empty token the admin guard would
    // reject as a plain 401 — a misconfiguration must not be readable as
    // "the walker declined the request".
    return NextResponse.json(
      { error: "RPC_ADMIN_TOKEN not configured", ok: false },
      { status: 500 },
    );
  }

  // Forward the caller's own query string so ?limitSets= / ?forceRefresh= still
  // work for a manual invocation through this route.
  const target = new URL(request.nextUrl.toString());
  target.pathname = "/api/admin/backfill-topshot-catalog";

  const inner = new NextRequest(target, {
    method: "GET",
    headers: { authorization: `Bearer ${adminToken}` },
  });

  return runCatalogBackfill(inner);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
