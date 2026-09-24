# Overnight pass handoff — 2026-08-25

**Mode: NO-PUSH (cloud Cowork).** `remote.origin.pushurl` on the mount was EMPTY, so the clone fell back to the credential-less `remote.origin.url` and `git push --dry-run origin main` failed with `could not read Username for 'https://github.com'`. This is the known cloud-session limitation (Trevor's box + Claude Code push normally). DB migrations, artifact repairs and verification were available; **nothing clearly-safe + net-positive was found to ship**, so this is a quiet, honest night. Continuity docs are written to the mounted tree, flagged **uncommitted (push unavailable)** — a future push-capable pass or Trevor will commit them.

- **Run:** `night-20260825T080419Z` · genuine overnight (real local ~01:04 PT).
- **Clock check:** shell `date -u` 08:02:37Z vs DB `now()` 01:02:48 PT (= 08:02:48Z) — <15s drift, NOT skewed. `max(ingested_at) sales` 07:57Z and `max(computed_at) fmv_snapshots` 07:56Z both bound real time from below. Overnight window confirmed.
- **Lock:** prior lock was RELEASED (08-24 11:06 PT, rpc-context-hygiene). Took it over as `night-20260825T080419Z`. Released at end of run.
- **Freeze:** none.
- **Ship budget used:** 0 of 4.

## What was reviewed

- **Continuity:** `ledger.md` (read through the 08-24 Claude Code interactive entries), `focus.md` (accuracy-gate phase; PRIORITY-3 saturation bar; DO-NOT-ARCHIVE steer), `metrics-latest.json` (last run 08-24T0804Z, also NO-PUSH, shipped nothing), inbox (clone and mount identical, ~200 filings — the intended steady state per the corrected `inbox_archiving_note`).
- **Inbox candidates drained (new since last pass):** two daytime-monitor filings from tonight (0011Z, 0312Z) + the 0620Z Flowty-pagination re-file (already in ledger, Claude Code 08-24). Both new ones are explicitly framed "a decision, not a diagnosis / Trevor's call" -> QUEUED below.
- **Artifacts:** 11 present, none flagged broken/stale in the inbox; the daytime monitor validated `rpc-live-health` 12/12 backing views this tick. No repair needed.

## Post-ship regression watch — CLEAN

Changes in the last ~24-48h were all **Claude Code interactive (08-24)**, not autonomous, deployed from Trevor's box. All three code changes are honesty guards that can only make a failed read report honestly (fail-safe direction only):

- `d8962ae1` — saved-wallets: a failed COUNT could re-seed a user's wallets. Target metric: no spurious `saved_wallets` upserts. **No regression** — saved-wallets write path unchanged on happy path.
- `024bafaf` — sentinel TS-writer-leak arm reported ok from a failed count. Target metric: leak arm honesty. **No regression** — Top Shot editions +3 in 24h (19838->19841), nowhere near the 250 leak-warn threshold, so the underlying metric is healthy.
- `02b2e849` — candy-offers ratio guard failed open. **No regression.**
- Flowty pagination filings (`2d9355be`, `bf41abe0`, `48d880c7`) — docs only.

No new pipeline-failure class, no new Sentry issue, and security is clean -> nothing attributable to any recent ship.

## Section 2 health-drift findings + deltas

- **Security:** ALL CLEAN. `check_public_security_invariants()` `[]`; RLS-off base tables `[]`; anon/authenticated write-holes on RLS-off tables `[]`.
- **Stalled pipelines:** one — `weekly-db-maintenance` (info severity, log-purge housekeeping, pg_cron jobid 198, daily 09:40Z). Last ran 08-23 09:40Z; **missed the 08-24 09:40Z tick**, ~46.5h silent (2788 min vs 1800 bar). Self-heals at 09:40Z today. Watch: if it misses again (08-25 09:40Z), escalate — could be a pg_cron-startup miss under saturation.
- **Pipeline failures (24h):** dominant classes all saturation/structural/known —
  - `topshot-pack-pool-backfill` 100% (278/278) — cause shifted from 403 to a 200-level "no editions" (QUEUED #A below).
  - `reconcile-saved-wallet-stats` 90.9% (20/22) — **all `soft_deadline_reached_partial_sweep_committed`, by-design** partial-sweep (commits partial work, reports not-ok). `oldest_cache_h` climbing 379->386h because each tick hits the 40s soft deadline after ~1 wallet — a saturation symptom (PRIORITY-3 bar; not re-investigated). NOT a regression from the 08-23 searchpath fix.
  - `sync-nba-projections` 100% (8/8) — ESPN/sports-proxy dark (known, ~Oct slate-gate).
  - `refresh_wmc_fmv_drift_active` 31.6%, `refresh_wmc_fmv_changed` 23.7%, `wallet-username-resolver` 62.5%, `topshot-active-listings-ingest` 80% (4/5) — all known saturation/operator-gated.
- **Trust health breaches (from monitor 0312Z tick, corroborated):** `public_board_slow_count=4` (candy-mlb boards, structural) and `unmapped_resolution_backlog_max=350` (nfl_all_day, ~47k actionable, chronic). Both known-structural.
- **`rpc_ops_snapshot()` TIMED OUT** on its `sentinel_fmv_confidence_rows` leg (`canceling statement due to statement timeout`) — the expensive FMV-confidence aggregate under the ongoing saturation window. Individual cheaper legs were run instead. **FMV HIGH/MED counts were deliberately NOT force-computed** to avoid adding IO during a spell (focus PRIORITY 3).
- **Sentry:** 0 new/escalating in 24h (per monitor tick) — but Sentry has been reported **dark since 08-18** (inbox 08-23T0250Z), so "0 new" may be instrument silence, not proof of no errors. QUEUED (needs route/config work, NO-PUSH).
- **Vercel:** production deploy READY (`b3230e36` per monitor); newest CANCELED is the expected docs-only ledger commit (`vercel.json` ignoreCommand).

### Metric deltas vs 08-24 metrics-latest.json

| metric | 08-24 | 08-25 | note |
|---|---|---|---|
| total editions | 27,246 | 27,249 | +3 (Top Shot 19838->19841) |
| db_size_mb | 13,848 | 13,918 | +70 (normal growth) |
| trust: public_board_slow_count | 3 | 4 | candy-mlb structural |
| trust: unmapped backlog max | 361 | 350 | draining net ~-25/day |
| Sentry new 24h | 0 | 0 | dark-since-08-18 caveat holds |
| artifacts | 11 | 11 | none broken |

## SHIPPED

None. NO-PUSH, and nothing clearly-safe + net-positive found. No DB migration, no code deploy, no data mutation, no edge-fn, no artifact change.

## QUEUED (each with ready-to-run spec + why not auto-shipped)

**#A — `topshot-pack-pool-backfill` error shifted from 403 to a 200-level "no editions"; the pipeline dominates the fail board at 99.6%.** (inbox `2026-08-25T0312Z`)
- **Why not shipped:** requires a *decision* (is "0/3 dists converted; 3 returned no editions" an exhausted finite backlog, or a real conversion regression?) that a read-only pass cannot settle, plus the ledger's "403-dead lane" belief for jobid 16 is now stale. Retiring/re-mapping the watchlist row is a mutation gated on that decision. NO-PUSH blocks the ledger correction anyway.
- **Ready-to-run (once decided exhausted):** re-map the terminal outcome so a "no editions" tick posts as done, not failed — e.g. in the pipeline's watchlist/outcome mapping treat `0 dists converted / all returned no editions` as `ok`; OR `DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline='topshot-pack-pool-backfill'` if the lane is retired. Confirm first in a quiet window that the user-facing pack pool is fresh (it is — `compute-topshot-pack-ev` healthy, insights freshness clean this tick).

**#B — `cross_collection_ts_set_overlap_mat` is ~51h stale and no standing instrument watches it.** (inbox `2026-08-25T0011Z`)
- **Why not shipped:** (1) the staleness itself is the `rpc-ccm-step2` statement-timeout — a saturation symptom under the PRIORITY-3 bar (refreshing the MV here would hit the same timeout; the real fix is cutting the step2 query's work = route/logic, off-limits). (2) The actionable part — adding a `cross_collection_overlap_stale_hours` arm to `v_rpc_trust_health` — modifies a **widely-read health instrument** (`rpc_ops_snapshot()`, the monitor, the sentinel all parse it), and tonight I could not fully verify the snapshot round-trips because its FMV-confidence leg is timing out under saturation. "When unsure, QUEUE."
- **Ready-to-run:** add an additive leg to `v_rpc_trust_health` computing `EXTRACT(EPOCH FROM (now() - max(computed_at)))/3600` over `cross_collection_ts_set_overlap_mat` as `cross_collection_overlap_stale_hours`, breach threshold ~30h. Rebuild the view **with `security_invoker=on` preserved** (footgun: a bare `CREATE OR REPLACE VIEW` strips it), verify `rpc_ops_snapshot()` still parses in a quiet window, then confirm the arm reads a number. Alternatively, if the overlap surface is judged low-traffic enough not to warrant a sentinel, record that decision so it stops being re-derived each first-tick.

## Still queued (carried, long-standing) — one-liners

- Sentry ingestion dark since 08-18 (needs route/config, NO-PUSH).
- #22 defeated credential-purge branch `claude/todo-implementation-e4tib3` still live at `ee94c8a2a` (operator-only: triage -> GitHub-UI delete -> GC -> rotate regardless).
- atlas-proxy wrangler deploy; sports-proxy 403 (ESPN slate-gated ~Oct).
- Two measured-but-unshipped DB fixes (`drain_fmv_cold_tail` unscoped aggregate; `compute_pack_ev_per_edition_weighted` fmv_current leg) — Trevor's call, both re-confirmed unshipped from live prosrc 08-24.
- git push credentials in cloud/desktop Cowork (blocks all autonomous code deploys).

## FAILED / AUTO-REVERTED

None.
