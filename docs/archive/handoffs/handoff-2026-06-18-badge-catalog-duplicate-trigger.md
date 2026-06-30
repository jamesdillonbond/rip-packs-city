# Handoff 2026-06-18 — badge-catalog "Failed (timeout)" on cron-job.org = a redundant duplicate trigger

Plain text. Claude Code's direct file inspection wins over this doc. The work is NOT failing.

## Diagnosis (measured live 2026-06-18)

cron-job.org "RPC Topshot Badge Catalog Sync" → `POST /api/badge-sync?mode=catalog` shows **Failed (timeout)**, but `pipeline_runs` (pipeline `topshot-badge-catalog`) is **`ok=true` every run**, ~`rows_written: 8927`, **`duration_ms` ≈ 150,000 (≈150s)**. The sweep completes server-side; cron-job.org just gives up at its **30s client cap** because the route is synchronous (`maxDuration = 300`).

## The real finding: this sweep is GitHub-Actions-owned BY DESIGN

`.github/workflows/badge-sync.yml` already runs the catalog sweep correctly — job `badge-catalog-sweep`, schedule `45 2,8,14,20 * * *` (4×/day at :45), `curl --max-time 600`. The route is **intentionally synchronous** for that long-timeout GHA curl, and the workflow comment is explicit:

> "The route runs up to ~300s synchronously, so it lives here (GHA curl --max-time 600), NOT on cron-job.org (30s client cap would mark every run failed + risk auto-disable)."

So the cron-job.org entry was added against the design. It can only ever show red, and it's a SECOND trigger firing the same 150s full-catalog sweep — the `pipeline_runs` clusters at off-:45 times (:13/:15/:29/:37…) are this cron-job.org entry (+ its retries), overlapping GHA's :45 runs and doubling the DB load (badge-catalog was a top contributor in the 04–05Z contention window).

## Fix — remove the duplicate, don't touch the route

**Primary (operator / Cowork — no code change):** delete the cron-job.org "RPC Topshot Badge Catalog Sync" entry. GitHub Actions already owns this sweep at :45 ×4/day, which is the designed cadence (coverage is long since converged at ~8,927 rows/run — it's now just a circulation/burn refresher). First confirm GHA's `badge-catalog-sweep` job is actually firing (GitHub → Actions → "Badge Sync" → recent runs) — the off-:45 `pipeline_runs` times suggest cron-job.org may currently be the de-facto trigger while GHA's scheduled run is delayed/skipping (GitHub cron is unreliable). If GHA is healthy, removing the cron-job.org entry is clean and correct.

**Only if you'd rather keep cron-job.org as the trigger (e.g. GHA scheduling proves too unreliable):** then wrap the catalog branch in the CRON-30S pattern so it stops showing red — `app/api/badge-sync/route.ts` L653-655:

    if (req.nextUrl.searchParams.get("mode") === "catalog") {
      after(runCatalogSweep())   // runCatalogSweep already logs its own pipeline_run
      return NextResponse.json({ ok: true, accepted: true, mode: "catalog", pipeline: CATALOG_PIPELINE }, { status: 202 })
    }

(add `after` to the `next/server` import). But note GHA also hits this route — after the wrap, GHA's curl returns at the 202 instead of waiting, which is fine (the sweep still completes in the lambda), but you'd then want only ONE of {GHA, cron-job.org} triggering it regardless. Don't run both.

## Bottom line

Nothing is broken. Either delete the cron-job.org entry (designed answer, GHA owns it) or de-dupe to a single trigger. The route is intentionally synchronous and shouldn't be wrapped unless cron-job.org becomes the sole trigger.

## Resolution — verified 2026-06-18 (Claude Code)

GHA health confirmed (the precondition this doc asked for): `gh run list --workflow=badge-sync.yml` shows the `badge-catalog-sweep` job **firing and succeeding** — recent catalog ticks 06-17 22:25Z (run 27723658617), 17:37Z (27707983455), 12:39Z (27689566052) all `badge-catalog-sweep: success`, alternating with the `:15` tag-sweep job. GitHub cron lands the `:45` slot late but the sweep completes every time. So GHA owns the catalog sweep and is healthy.

**Decision: take the designed answer — operator deletes the cron-job.org "RPC Topshot Badge Catalog Sync" entry. No code change.** The `after()`/202 wrap (the alternative above) was implemented and then **reverted** — the route is left synchronous by design for GHA's `--max-time 600` curl. Tracked as **BADGE-CATALOG-CRONJOB-DUP** in [docs/overnight/ledger.md](overnight/ledger.md).
