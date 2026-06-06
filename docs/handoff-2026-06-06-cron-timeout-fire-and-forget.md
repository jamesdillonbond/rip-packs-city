# Handoff — kill the cron-job.org 30s timeout failures (CRON-30S) — fire-and-forget the slow populate routes

## Findings (cron-job.org dashboard review + pipeline_runs, 2026-06-06 ~20:45Z)

Four entries show "Failed (timeout) (30 s)" — cron-job.org's hard client cap, NOT route failures:

1. **RPC wmc-fmv-populate** (`/api/wmc-fmv-populate?limit=5000`, every 20 min) — VERIFIED healthy server-side: 77 pipeline_runs / 6h, 1 fail, avg 13.4s/leg, image+FMV sync all landing. The route just takes >30s to RESPOND (sequential per-collection FMV populate + populate_wmc_image + refresh_wmc_fmv_changed), so cron-job.org marks every tick failed. RISK: cron-job.org auto-disables persistently-failing jobs — that would silently kill the image-populate AND FMV-drift pipelines (the silent-failure class). Also: permanent red noise masks real failures.
2. **RPC TopShot FMV Populate** (`/api/topshot-fmv-populate`, ~6h cadence) — WORSE: zero pipeline_runs rows in the last 6h window. Either it crashes before logging (silent-death class — fatal path must log) or the name drifted. Investigate first, then apply the same fix.
3/4. **RPC AllDay Pack Distributions** + **RPC Golazos Pack Distributions** (supabase edge fn `seed-allday-pack-distributions`, 6h cadence) — both time out at 30s client-side with no pipeline_runs visibility. Lower priority.

## Fix (the CLAUDE.md-sanctioned pattern: fire-and-forget >30s work)

**Item 1 — `app/api/wmc-fmv-populate/route.ts` (primary, do first):** keep auth + target resolution synchronous, then `import { after } from "next/server"`, wrap the per-collection loop (FMV populate + image populate + refresh_wmc_fmv_changed) in `after(async () => { ... })`, and return `202 {accepted:true, targets:[...]}` immediately. Per-collection `log_pipeline_run` calls already exist inside `runOne` — keep them; they're the real success signal. Add a fatal-catch `log_pipeline_run(ok=false)` inside the after() so a crashed background pass still surfaces (pipeline_runs-as-crash-logger convention). Expected: cron-job.org flips to ~quick Successful 202s; pipeline_runs unchanged (~77 ok/6h).

**Item 2 — `/api/topshot-fmv-populate`:** first check why nothing logged in 6h (route reads `pipeline_runs` under pipeline='topshot-fmv-populate'; the documented behavior was honest ok=false rows on pool timeouts — total absence smells like a crash before logging or a renamed pipeline). Then same after() + fatal-catch treatment.

**Items 3/4 — `supabase/functions/seed-allday-pack-distributions`:** respond early + `EdgeRuntime.waitUntil(work)` (Supabase edge supports it), and add `log_pipeline_run` calls so the work is observable at all. If waitUntil is awkward, reduce per-call work (smaller batch + more frequent cron). Lower priority — verify whether the seeding is even still completing (no pipeline_runs evidence either way).

**Hygiene (optional, while in the dashboard):** 4 entries pass the INGEST token as `?token=` in the URL (allday-fmv-populate, allday-listing-cache, pinnacle-sales-indexer, support-report) — visible in dashboard/history. Migrate them to the `Authorization: Bearer` header field like the newer entries. Not urgent; do opportunistically.

## Verify

- tsc clean; deploys READY.
- cron-job.org: next ticks of the fixed entries show Successful (sub-second).
- pipeline_runs cadence unchanged: `SELECT pipeline, count(*), count(*) FILTER (WHERE NOT ok) FROM pipeline_runs WHERE pipeline IN ('wmc-fmv-populate','topshot-fmv-populate') AND started_at>now()-interval '6 hours' GROUP BY 1;`
- Image drain + FMV drift keep moving: global imaged count still climbing; Dumbo drift stays ~0.

## Guardrails / revert

Don't change what the routes DO — only when they respond. Vercel `after()` inherits maxDuration (300 here) — no cap changes. Revert: `git revert <commit>` per route. No DB changes.
