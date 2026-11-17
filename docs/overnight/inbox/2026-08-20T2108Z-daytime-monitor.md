# Daytime monitor — 2026-08-20T21:08Z (≈14:08 PT)

Written to the MOUNT, push unavailable (`remote.origin.pushurl` absent on desktop Cowork; only the public `remote.origin.url` is set, no creds — consistent with the 08-19/08-20 nightly and every 08-19/08-20 daytime tick). Night pass picks this up locally. Lock RELEASED (08-20T08:15Z by the nightly pass, stale >45min), so no concurrency skip.

⚠ Active severe saturation spell: positive control **io_wait 31 / active 32** (near-total; a strict majority in IO wait) and `rpc_ops_snapshot()` timed out on call. Per §1c everything below is a **SYMPTOM under saturation** — no cause claim, no cost figure, no "cheap/expensive" judgment; every suggested action is a **quiet-window RE-MEASURE**, not a fix.

## The one additive signal: two pipelines silent ACROSS the intraday clear windows (re-measure to separate a stopped job from spell collateral)

The intraday spell is intermittent (0012Z tick read 0/0 CLEAR, per the 0306Z filing). A job that is merely spell collateral should advance during those clear windows; a job that stays silent through them may be genuinely stopped. Two `detect_stalled_pipelines()` members fit the second shape this tick and are **not** already owned in the ledger/inbox:

- **`snapshot-institutional-wallets` — severity HIGH, ~2103 min (~35h) silent vs 1800 threshold.** Daily cron-job.org job (external — `check_pgcron_recent_failures()` cannot see it); `last_run` 2026-08-19T10:07Z, so today's ~10:07Z tick produced no row. Most-likely-innocent read is the documented candy-editions class (route logs to `pipeline_runs` only on completion, so a timeout leaves silence, not a failure row) — but it is HIGH severity and has now missed a full daily tick, so **re-measure in a confirmed quiet window**: if it stays silent with IO free, treat as a genuinely-stopped external cron and check the cron-job.org entry; if it advances, it was collateral. First appearance in the stalled set across recent ticks.
- **`compute-golazos-pack-ev` — medium, ~1233 min (~20h) silent vs 800 threshold.** `last_run` 2026-08-20T00:37Z. Flagged at 2107Z (08-19) too (871m then), and it has **not recovered across the intervening clear window** — climbing, not oscillating. Same disposition: quiet-window re-measure to distinguish a stopped compute from collateral; only escalate if Golazos pack-EV coverage actually drops.

Suggested action for both: **quiet-window RE-MEASURE only.** No fix, no cause. The lever for the underlying saturation is cutting work (page size / precompute / fan-out), never raising a timeout or the tier (focus §3).

## Confirmed, NOT re-raised (avoid inbox duplication)

- **Afternoon-peak saturation persists** — io_wait 31/32 at ~14:08 PT, matching the 08-19 2107Z afternoon-peak (33/33). Confirms the already-filed intraday pattern (2107Z + 0306Z: afternoon saturated, evening intermittent). A data point, not a new cause.
- **Cross-collection MV staleness** — `rpc-ccm-step1` (04:10Z) + `rpc-ccm-step2` (04:25Z) both failed again today on statement timeout → the `cross_collection_*_mat` cycle has now missed a 4th consecutive night. Owned by `2026-08-19T1511Z` CANDIDATE 1, re-confirmed by `2026-08-20T0012Z`/`0306Z` and the 08-20 nightly ledger entry. Recovery = overnight self-cleaning per-step one-shot (step1's TRUNCATE takes ACCESS EXCLUSIVE — not a mid-day/mid-spell run). Read-only freshness miss, no data loss. No re-file.
- **pg_cron: ~21 jobs with recent fails, ALL `statement timeout` / `job startup timeout`, ZERO logic errors** → one saturation signature per §1c, not 21 bugs (incl. the allday-ev / market-index / allday-pack MV refreshes, pinnacle-acquisitions backfill, fmv display/thin/clamp guards, weekly-log-purges, thp-impossible-parallel). None post-date a same-day fix. Known-class collateral.
- **Other `detect_stalled_pipelines()` members are known-class:** `candy-editions-ingest` (2190m — documented 300s-timeout-leaves-no-row class, handoff `2026-08-04`), `weekly-db-maintenance` (2130m — its 09:40Z pg_cron tick `rpc-weekly-log-purges` is in the timeout cluster above), `refresh-special-serial-owners-mv` (1707m — its 16:43Z pg_cron tick job-startup-timed-out), `topshot-active-listings-ingest` (1377m vs 900 — dropout-prone GHA / atlas-proxy egress, known), `wallet-username-resolver` (182m — known stale threshold vs cadence, medium/visibility-only).

## Clean baseline for the night pass

- Security: `rls_off_base=0` (no public table with RLS off). Sentry: 0 new unresolved issues in 24h. Vercel: no ERROR deploys in the recent window; latest production READY is 08-18 `fix(collection) Top Shot series filter`; the 08-20 20:31Z `docs(claude.md)` deploy is a CANCELED (expected `ignoreCommand` docs-only skip) — nothing shipped since 08-18.
- Artifact payload validation **deliberately skipped** this run — in a severe spell a timed-out payload query is a symptom, not a broken artifact, and re-running heavy payloads only stacks IO (§1b/§1c). Defer to a quiet-window validation pass.
