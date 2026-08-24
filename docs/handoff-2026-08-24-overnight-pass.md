# Overnight autonomous pass — 2026-08-24 (~01:04 PT)

**Mode:** Cowork cloud, **NO-PUSH** (`remote.origin.pushurl` empty, `git push` refused — no creds).
**Outcome:** **Nothing shipped.** Health is green modulo the known structural saturation class. Post-ship watch on the last three ships is all green, and one shows a strong positive effect.

> ⚠ This git-push blocker is specific to **this cloud session**. Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. **Commit the output files below (ledger, metrics, this handoff) as usual** — they are written to the clone AND mirrored to the mount so they persist on the box.

---

## Continuity / real-time
- Real time from DB `now()` = 2026-08-24 08:02:46Z ≈ **01:04 PT** — genuine overnight. Shell clock drift 11–13s, not skewed.
- Lock: prior lock was RELEASED; took it, will mark RELEASED on exit.
- No `docs/FREEZE.md`.
- Ledger top matter read; inbox read (fresh 08-24 candidates + late-08-23 post-ship items); `metrics-latest.json` read.

## Health sweep
- **Security 4/4 clean** — invariants / anon_write_holes / rls_off_base_tables / secdef_anon all `[]`.
- **`trust_precompute_max_age_hours` 5.27** (< 13 breach) → the red trust arms are real, not a stale-refresher artifact.
- **Trust breaches (2), both known-structural:** `public_board_slow_count`=3 (candy-mlb boards) and `unmapped_resolution_backlog_max`=361 (All Day ~47k actionable rows, ~1047 d to clear at current outflow).
- **Pipeline alerts:** all high-sev failure rates are saturation-class (statement / lock / connection-pool timeouts, upstream request timeout) under the known R46 structural root — decided 08-23: no capacity change, permanently. No new non-saturation class.
- **Vercel runtime (24h):** 50 error groups, entirely saturation-class (Vercel task timeouts, connection-pool timeouts, candy-mlb board timeouts, edition/pack read-bound guards degrading gracefully). DEP0169 `url.parse` is a benign node warning. **No new non-saturation class.**
- **Sentry:** 0 new in 24h — ⚠ but Sentry is reported dark since 08-18 (inbox 08-23T0250Z), so "0 new" is possibly instrument-silence, not proof-of-none. QUEUED.
- **Artifacts:** 11 present, none flagged broken/stale. No repair needed.
- **db_size** 13,848 MB.

## Post-ship watch — all green
1. **`20260823081000`** (last night — RESET search_path on `reconcile_all_saved_wallet_stats` + `rpc_trust_health_precompute_refresh_p`): **HOLDS.** `reconcile-saved-wallet-stats` is committing (`soft_deadline_reached_partial_sweep_committed` is the by-design partial-sweep path; the `2D000` it targeted is gone; 02:44Z ran fully `ok`). The 4-run silence since 03:44Z is the known saturation / pg_cron startup-timeout class, not a regression. Metric to re-check: absence of `2D000` and continued per-wallet commits.
2. **`20260824033743`** (evening Cowork cloud — UFC + Golazos `promote_unmapped_sales` legs parked via the function's own `promote_recheck_after` marker): **HOLDS.** 1079/1079 parked (UFC 1070 + Golazos 9); All Day untouched; auto-re-tests 2026-09-23. ⚠ No ledger entry existed for this ship — recorded this pass. Revert: `UPDATE unmapped_sales SET resolution_hint = resolution_hint - 'promote_recheck_after' WHERE collection_id IN ('9b4824a8-736d-4a96-b450-8dcc0c46b023','06248cc4-b85f-47cd-af67-1855d14acd75') AND resolution_hint ? 'promote_recheck_after';`
3. **panini-squeeze cutover** (evening — `rpc-refresh-panini-squeeze` ~13,040 → ~491 worker-s/day): **STRONG POSITIVE.** `public_board_liveness_sweep` ran **45/45 twice** post-cutover (00:28 @34s, 06:28 @85s) vs 0/45 and 6/45 before. Corroborates the 08-24T0225Z filer's contention hypothesis; per their own guidance this **de-escalates the board-watchdog durability fix from urgent to correct-hygiene.** ⚠ No ledger entry existed — recorded this pass. Metric to re-check: sweep continues to complete 45/45 at 12:28 / 18:28.

## Why nothing shipped
NO-PUSH removes all code deploys. Of the DB-shippable candidates none was clearly-safe AND net-positive:
- The board-watchdog durability PROCEDURE conversion is the one DB-shape change on the table, but tonight's post-ship watch **de-escalated it to hygiene**, and shipping it now would make the panini-cutover effect unmeasurable (the filer explicitly said not to). QUEUED.
- Everything else fresh is FMV/pricing route logic (off-limits), a product decision, or needs a quiet-window measurement first.

## Queued — for Trevor / a push-capable pass
- **board-watchdog durability** — convert `public_board_liveness_sweep` to a PROCEDURE with `COMMIT` per board so completed probes survive a slow board; surface `skipped`/`budget_exhausted`; matching cron `SELECT`→`CALL` (jobid 288, postgres-owned). Now **hygiene**, not urgent — schedule calmly; re-confirm the sweep still completes 45/45 first.
- **jobid-303 `refresh-wmc-fmv-changed` telemetry** — largest job on the box (48,111 worker-s/day) writes NO `pipeline_runs`, and a 9×-cheaper app caller wears its name. Remedy 1 (read `cron.job_run_details` not `pipeline_runs` for this job — zero code) and Remedy 2 (wrap cron call in `log_pipeline_run` under a *distinct* name). FMV path → off-limits to autonomous ship. Inbox 08-24T0400Z.
- **`topshot-active-listings-ingest`** — residential arm ~7/8 red on a `GET targets` DB timeout; `topshot_serial_board_targets` runs an unbounded `DISTINCT ON` scanning 857,293 rows to return 13,230 (~6.2 GB buffers/call, mean 44% of the 30 s ceiling). Needs `EXPLAIN (ANALYZE, BUFFERS)` in a 13:00–17:00 PT quiet window and **R52 re-litigation** now that it has a second, harder consumer. #20 (`atlas-proxy`) fixes only 22.5% of failures. Inbox 08-24T0430Z.
- **fmv-haircut TS leg** — 800,545 buffers / 101 s to find 14 rows; the obvious `edition_fmv_current` fix is **refuted** (loses 71% of rows — stale filter columns). Widened-step-1 variant unmeasured. Also correct the gateway-vs-`statement_timeout` misattribution comment in `app/api/admin/apply-fmv-haircut/route.ts`. FMV logic → off-limits. Inbox 08-24T0455Z.
- **LOW-confidence label** — ~1,000 high-volume editions publish LOW; mechanism CONFIRMED by-design (MEDIUM dispersion ceiling at count≥7). The sub-dollar-tick theory is FALSIFIED. Only durable observation: `LOW` conflates "no data" with "market disagrees" — a product/label decision (new enum touches every surface). Inbox 08-24T0225Z.
- **Sentry dark since 08-18** — investigate ingestion; "0 new" is unreliable until fixed.
- **Standing operator blockers:** git push creds (cloud/desktop Cowork), `atlas-proxy` wrangler deploy, sports-proxy ESPN 403.

## Notes
- **Inbox archiving skipped by design.** NO-PUSH archive moves can't reach origin, and each pass re-clones from origin, so archiving churns with no effect. ~200 un-archived files is the accrued cost of the long NO-PUSH streak; a push-capable pass should archive resolved items (UFC/Golazos, LOW-confidence, board-watchdog, panini can be archived once their ledger entries are on origin).
- Two evening prod-state changes (UFC/Golazos park; panini cutover) had **no ledger entry** — added this pass.

## Failed / reverted
None. No shipping attempted.

---

## ⛔ CORRECTION — 2026-08-24 (Claude Code, Trevor's Windows box): the "archive resolved items" item above is REFUTED. **`docs/overnight/inbox/` is APPEND-ONLY, by a rule with a CI guard behind it.**

I am the push-capable pass this handoff queued that work for. **I attempted it and the guard stopped me**, which is the outcome working as designed.

**The rule:** [`docs/overnight/focus.md`](overnight/focus.md) — *"The convention and the citation practice are in conflict, and the citations win. Treat `inbox/` as append-only. If the directory's size becomes a real problem, the fix is a redirect/stub or an index — not a `git mv`."* **Filings are permanent citation targets**: the ledger, handoffs, the roadmap, committed migrations and live product source all reference them **by exact path**, and a migration is immutable history that must not be edited to chase a move. The guard is `__tests__/inbox-is-append-only-since-the-rule.test.ts`, which **bans any filing dated on or after the rule from sitting in `archive/`** — it reddened on both files within a minute of the `git mv` and named them.

⚠ **So the framing is wrong too, not just the action.** *"~200 un-archived files is the accrued cost of the long NO-PUSH streak"* reads as debt. **It is the intended steady state.** The NO-PUSH streak did not cause it and a push-capable pass cannot "pay it down" — the count is managed by `INDEX.md`, which is exactly the "index, not a `git mv`" remedy the rule prescribes.

⚠ **This is the shape CLAUDE.md warns about: a filed DECISION is a hypothesis, and it is the one nobody re-checks** — a queued cleanup reads as obviously-safe housekeeping, so it gets executed rather than re-derived. **Both files were `git mv`-ed back; tree restored to 224 on disk / 224 listed, both INDEX counts intact, both inbox guards green.**

ⓘ **One thing salvaged from the attempt:** the sitemap filing gained a **✅ RESOLVED** section recording that #28 is closed and how it was verified. **That is the correct way to retire a filing — annotate in place, never move it.**
