HANDOFF — Make /api/sales-indexer fire-and-forget (stop the cosmetic cron-job.org timeout)
Date 2026-05-31. Small, low-risk. File: app/api/sales-indexer/route.ts (TopShot sales indexer).

CONTEXT
A cron-job.org backup for TopShot sales was added 2026-05-31 (URL https://www.rippackscity.com/api/sales-indexer, POST, */20, same auth header as the AllDay entry). It WORKS — verified via pipeline_runs: every trigger produces an ok=true topshot-sales-indexer run (~24-33s). But cron-job.org reports "Failed (timeout)" because the route runs SYNCHRONOUSLY (~24-33s) and exceeds cron-job.org's ~30s request window. The work still completes on Vercel, so it's cosmetic — but a permanently-red job is misleading (can't distinguish a real failure) and clutters the dashboard, exactly like the existing "RPC TopShot FMV Populate" entry.
Root cause (confirmed in code): app/api/sales-indexer/route.ts does NOT use `after()` — it does the full chain scan + ingest before responding (returns NextResponse.json at ~L627/L658). By contrast app/api/allday-sales-indexer/route.ts imports `after` (L1) and wraps its work in `after(async () => { … })` (~L405), so it returns in ~168ms and cron-job.org reports Success.

WHY IT ALSO MATTERS: separately, the GitHub-Actions trigger (rpc-pipeline.yml, */20) has been under-delivering — pipeline_runs shows TopShot sales-indexer runs ~1.5-2h apart, not every 20min (GH scheduled crons drop under load; this morning it gapped 01:32-08:02). So the cron-job.org backup genuinely restores 20-min freshness; making it report Success cleanly is worth doing.

GUARDRAILS: direct to main, no branches/PRs; PowerShell git + verify push; no CRLF string-replace patches; tsc clean.

THE CHANGE (mirror allday-sales-indexer exactly)
File: app/api/sales-indexer/route.ts
1. Import `after`: `import { NextRequest, NextResponse, after } from "next/server"` (it currently doesn't).
2. Keep the auth check synchronous and FIRST (the existing 401 at ~L13 must stay before anything async — validate, reject unauthorized callers immediately).
3. After auth passes, schedule the existing indexing body inside `after(async () => { … })` and return a fast 202 immediately: `return NextResponse.json({ status: "accepted" }, { status: 202 })`. Move the cursor read + scan + ingest + the final `log_pipeline_run`/pipeline_runs insert INSIDE the after() block (so it still logs ok/error exactly as today — just asynchronously). Use allday-sales-indexer's structure as the template (auth → after(async () => { …all the work + run logging… }) → return 202).
4. Confirm `export const maxDuration` is high enough for the async work (~60-120s; match or exceed allday-sales-indexer's). Vercel keeps the after() work running after the 202 is sent, up to maxDuration.
Note: the route is idempotent (dedups on sales.transaction_hash), so the fast-return + async work is safe even with GH Actions + cron-job.org both firing.

REVERT: git revert the commit.
VERIFY:
- npx tsc --noEmit clean; deploy READY.
- cron-job.org: "Run now" on RPC TopShot Sales Indexer → now returns fast → Status SUCCESS (no more timeout).
- pipeline_runs still gets a fresh topshot-sales-indexer ok=true row per trigger (confirm sales freshness unchanged): SELECT ok, started_at, extra FROM pipeline_runs WHERE pipeline='topshot-sales-indexer' ORDER BY started_at DESC LIMIT 3;

EXPECTED END STATE: /api/sales-indexer returns 202 in ~ms; cron-job.org reports Success; TopShot sales ingest continues (async) exactly as before, now reliably every 20 min from cron-job.org + whatever GH Actions delivers.
