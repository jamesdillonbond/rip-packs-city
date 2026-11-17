# Daytime monitor — 2026-09-13 ~11:07 PT (18:07Z)

Read-only sweep during an active **saturation spell** (positive control: `pg_stat_activity` io_wait **21** ≥ active **20**, 49 total; `rpc_ops_snapshot()` timed out — itself a spell tell). Per spell discipline everything below is filed as a **SYMPTOM**, not a cause; suggested actions are quiet-window **re-measures**, never conclusions. No heavy artifact payload queries were run this tick (they would stack IO onto the saturation and time out uninterpretably — re-validate the artifact estate in a quiet window).

Security 4/4 clean (0 RLS-off public tables, invariants/secdef-anon empty). No Vercel ERROR deploys — latest production `dpl_6a2Zw…` (sha `a93b664c`, concierge badge-rule) is READY; the CANCELED entries are the normal superseded-in-flight pattern from rapid concurrent pushes. No today-ship correlates with a regression (several reduce load).

---

## CANDIDATE 1 — SYMPTOM: autovacuum is now RUNNING on `net._http_response`'s toast (`pg_toast_51873`, register #75), mid-spell

- **Source:** `pg_stat_activity` — `autovacuum: VACUUM pg_toast.pg_toast_51873`, running **~1,795 s (~30 min)** in `IO / DataFileRead` at the time of the sweep. `pg_class` confirms `pg_toast_51873` is the toast of **`net._http_response`** (the 12 GB store, #75).
- **Why it matters:** today's ledger (#75, entry 2) recorded the toast's `autovacuum_count` as **still 0** ("autovacuum has never run on it"), and a separate deploy (`f3a5eb8e`) says the **#75 VACUUM FULL is decided and scheduled for the 19:05 PT quiet window**. An autovacuum now in progress on that exact relation is a **state change** and interacts with a planned `VACUUM FULL` (lock contention / the autovacuum may already be reclaiming, changing the reclaim math). It is also a live IO contributor to the current spell (a plain VACUUM scans all 12 GB).
- **Risk read:** read-only observation; no action taken. The autovacuum is arguably healthy (the store finally being maintained) but is a heavy IO cost during a daytime spell and may change the #75 decision.
- **Suggested action (quiet-window RE-MEASURE, not a conclusion):** before the 19:05 PT VACUUM FULL, the owning session should re-read whether the autovacuum has completed and re-check `net._http_response` heap/toast size + `pg_stat_all_tables.last_autovacuum` / `autovacuum_count` on the toast — the reclaim may already be partly done, or an in-flight autovacuum may need to finish/be accounted for first. Do **not** start a manual VACUUM against it during a spell (the 10:3x PT ledger note already records that mistake — 90 s of self-inflicted IO, cancelled at budget).

## CONTEXT (all KNOWN / already tracked — filed so the drain doesn't re-chase)

- **The spell itself** at ~11:07 PT is the standing instance-level saturation class (**#104 / #42 / #73 / #84 / go-live M11**), outside the usual wallet-backfill wave windows (hrs 0/1 & 12/13 PT). Live heavy lanes seen in IO wait: `refresh_topshot_pack_rip_values()` (223 s), `refresh_wmc_fmv_changed(30,200000)` (103 s, #36/#42), `atlas_market_drain()` (103 s), a concurrent `REFRESH MATERIALIZED VIEW CONCURRENTLY mv_topshot_m…` (103 s), `atlas_listing_verify_tick(2)` (#85/#107), plus the #75 toast autovacuum above. User-facing PostgREST reads (`v_topshot_edition_pull_provenance`) dragged to 10–24 s — spell collateral, not a view defect; do not conclude from spell-time durations.
- **pg_cron failure cluster (17 jobs)** — **all** `canceling statement due to statement timeout` / `job startup timeout`, **zero logic errors** → saturation collateral, not N bugs (per §1c). The high-rate ones (`rpc-ts-listings-atlas-sync` 192/719, `rpc-allday-unmapped-atlas-resolver` 74/287, `rpc-atlas-market-drain` 52/719, `rpc-wmc-parallel-rekey` 14/48) are #42/#85/#107 territory — chronic-vs-spell split is a quiet-window question, not now.
- **`detect_stalled_pipelines()`** flagged two: `reconcile-saved-wallet-stats` (silent 265 min / thr 150) is **explained** — its pg_cron job `rpc-reconcile-saved-wallet-stats` is in the timeout cluster (4/24), i.e. spell collateral, not a genuine stop. `apply-fmv-haircut` (silent 2,614 min / thr 1,800, last run 09-11 22:35Z) is **already under active watch** — a session scheduled a 15:50 PT verification of today's tick (ledger entry, this session). Not re-filed as new; the 15:50 PT check owns it.
- **`cross_collection_ts_set_overlap_mat` frozen** — #108 (filed today; `ccm-step2` cannot finish in 300 s on a calm instance; retry jobid 491 deactivated; board renders its own `computed_at` so it's honest about the age). Not new.
- **Trust breach `topshot_impossible_parallel_serials=29`** — #82, Trevor-gated repair. Not new.

---

**Inbox written to mount, push unavailable** — the sandbox shell/git clone is down (Sept-8 Windows-update mount failure, 5th+ night per the released `.lock`), so this file was written directly to the mounted tree via the file tools rather than committed in a fresh clone. The nightly pass will pick it up locally. Concurrency lock is **RELEASED** (not held), so no commit was skipped for lock reasons — the commit was simply unavailable.
