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

// ⛔ UNSCHEDULED 2026-09-04 — THE ROUTE IS KEPT, ITS CRON IS NOT.
//
// The walker this wrapper calls reads `public-api.nbatopshot.com`, which has answered
// **HTTP 530 (Cloudflare 1033, origin decommissioned) on every request since 2026-08-28**.
// Measured 2026-09-04 from `pipeline_runs_daily`: **last success 2026-08-28, then 7 of 7
// ticks failed** (`page 0: HTTP 530: error code: 1033`). A daily arm that is red every day
// is worse than no arm — it teaches the next reader to skip this pipeline's failures.
//
// ⚠ IT IS UNSCHEDULED BECAUSE IT IS REDUNDANT, NOT MERELY BECAUSE IT IS BROKEN. All three
// jobs it owned now have live owners, and each was verified before this line was written:
//   • circulation → `topshot-circulation-onchain` (Vercel cron `5 4 * * *`, on-chain
//     `TopShot.getNumMomentsInEdition`), shipped 2026-09-03.
//   • tier + badges → the Atlas edition walk (`atlas_editions_dispatch`/`_drain`, pg_cron).
//     0 of 13,436 canonical Top Shot editions have a NULL tier; 13,312 carry an Atlas map row.
//   • prose + media → the same Atlas walk as of migration `20260905024630`. Atlas serves the
//     identical text at `editionTemplate.metadata.Description` — on a live 100-row page of
//     set 90, **64 rows would be FILLED and 0 CHANGED**, i.e. byte-identical where we already
//     hold it — and the CDN media at `assets[]` (`hero`, `video-square`), filled only where
//     NULL so an on-chain-resolved IPFS CID is never overwritten. First live tick after the
//     splice: `editions_enriched: 141`, 0 errors.
//
// ⚠ THE ONE JOB NOTHING INHERITED: creating editions rows Atlas knows and we do not (16 of
// 100 on that same page, all parallels such as `90:4046::1 "Explosion"`). That is NOT a
// regression from this change — the walker has created nothing since 08-28 — and it is left
// open deliberately: new-edition creation ripples into circulation, the sitemap and every
// entity surface, so it is a decision, not a chore. 195 Top Shot editions were still created
// in the trailing 14 days by the Cadence stub path, so the lane is not dark.
//
// The handler below is untouched and still works by hand (Bearer CRON_SECRET or
// INGEST_SECRET_TOKEN). **To restore: re-add**
// `{"path": "/api/cron/topshot-catalog-backfill", "schedule": "12 2 * * *"}`
// **to `vercel.json` — one line, nothing else.** It will 530 until the upstream returns.

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
