# Handoff — finish the cron-job.org → GitHub Actions migration (CC)

**Why (CC-only):** the remaining cron-job.org HTTP pipelines carry recurring, documented pain — the 30s execution cap, the "200 that's actually /login" auth gotcha, and the secret-in-DOM leak hazard (a session once leaked INGEST_SECRET_TOKEN reading a job-edit page). The 2026-06-27 backstop workflows (`sales-indexers-backstop.yml`, `wallet-backfill-backstop.yml`, `snapshot-institutional-wallets-backstop.yml`) prove the GHA pattern. The overnight pass CANNOT do this — its PAT lacks `workflow` scope, so `.github/workflows/**` changes are CC-only.

**Goal:** move every cron-job.org entry whose work is a single authenticated HTTP POST that finishes server-side (returns fast / uses `after()`) onto a scheduled GHA workflow. Leave on cron-job.org ONLY the ones that genuinely can't move: the Atlas residential-runner jobs (datacenter IPs are WAF-blocked) and anything needing a real residential egress.

**Authoritative source list:** `docs/operations/cron-schedule.md` (the current cron-job.org inventory). Reconcile against the live cron-job.org console before disabling anything.

**Per-pipeline recipe** (mirror the 06-27 backstops):
1. New `.github/workflows/<pipeline>.yml`: `schedule:` cron (UTC; stagger OFF the :00 rush), a single `curl -fsS -X POST` to the `www.rippackscity.com` route (apex 308-redirects — use www) with `Authorization: Bearer ${{ secrets.INGEST_SECRET_TOKEN }}` (or `CRON_SECRET` per the route), `--max-time` under the GHA step budget, and `-f` so a non-2xx fails the job.
2. Confirm the repo secret exists (it does for the ingest/cron tokens used by the backstops).
3. Let it run one full cycle; confirm `pipeline_runs` shows the pipeline `ok=true` on the GHA cadence and the GHA run is green.
4. THEN disable the cron-job.org twin (Trevor/operator — console action) so there's no double-fire. Several routes are already concurrency-guarded via `pipeline_run_locks`, but don't rely on it; disable the twin.

**Stagger discipline:** keep new schedules off `:00`/`:20`/`:40` clusters to avoid the connection-pool-saturation cron-rush already noted in the metrics.

**Revert (per pipeline):** delete the workflow file + re-enable the cron-job.org entry. No DB/state change.

**Verify done:** for each migrated pipeline, GHA history green on schedule + `pipeline_runs` ok=true on the new cadence + cron-job.org twin disabled.
