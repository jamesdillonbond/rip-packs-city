# Daytime monitor candidates — 2026-09-19T03:10Z (~8:10 PM PT 09-18)

Context: read-only daytime tick. DB reachable and **QUIET** — positive control `pg_stat_activity` io_wait 1 / active 1 / total 33, and `rpc_ops_snapshot()` completed (no timeout). **NOT a spell.** The 09-18 platform read-availability outage (~12:48Z→~19:01Z) is fully recovered. Security 4/4 clean; trust_health 39/39 ok, 0 breaches; all drift guards (search-path, procedure-txn, backward-cursor, suppression) `[]`; `sentinel_ts_uuid_editions_48h`=0. Vercel: last 8 prod tips are CANCELED **docs-only** commits from the active concurrent session (supersede-burst, expected; no ERROR). Most prior-tick owed items **self-healed**: `candy_offers_unverified_pct` 100→0, `detect_stalled_pipelines()` 3→0, jobid 506 FMV split fresh (01:35Z). The ~02:20–02:55Z statement-timeout cluster (lock-check-batch, backfill-pack-rip-metadata, pinnacle-nft-resolver, analytics-smoke self-reporting "db saturated") is the brief IO spell the concurrent session already diagnosed (9 active / 9 DataFileRead at 02:38Z), paused two jobs for, and resumed at 02:43Z — **owned + easing, not re-filed.**

## MEDIUM — `cross_collection_cohort_mat` is ~52h stale: `rpc-ccm-step1` timed out on TWO consecutive daily ticks (2nd-consecutive-day escalation threshold met)
- **Source:** `cron.job_run_details` jobid for `rpc-ccm-step1`; `max(computed_at)` on `cross_collection_cohort_mat`.
- **Observed (nailed, not eyeballed):** schedule is now `10 23 * * *` (this resolves the 0011Z file's "schedule may have moved — worth a glance": it moved to 23:10Z = 4:10 PM PT). Runs: **09-18 23:10Z FAILED**, **09-17 23:10Z FAILED** (both `canceling statement due to statement timeout` on `CREATE TEMP TABLE _ccm_step1_next ... COUNT(DISTINCT collection_id)`), 09-16 23:10Z succeeded, 09-15 23:10Z succeeded. So `cross_collection_cohort_mat.max(computed_at)` = **2026-09-16 23:10Z, ~52h stale** at run time. `rpc-ccm-step2` (overlap mat) is FRESH (09-18 23:25Z succeeded) — the enable_nestloop=off fix (08-25) still holds for step2; **step1 (cohort) is the specific failure.**
- **Correction to the 0011Z inbox file:** it logged this as "LOW … single occurrence … Impact now: none visible." That undersold it — it is **2 consecutive daily failures / 52h staleness**, not a one-off, and it meets the historical "escalate only on a second consecutive day" bar (ledger 07-13, 08-25 #108).
- **Impact:** the `/insights/cross-collection` **cohort_stats** surface (holders / cross-collection-collector cohort) can serve ~2-day-old cohort data. `board_mv_refresh_stale_hours`=2.98 (ok) does NOT cover this — that guards the board MVs, not the cohort mat, and there is **no standing trust-health arm on cohort_mat age** (the 08-25 filing proposed exactly such an arm for the sibling overlap mat and it was never added). So this degrades silently between ~8am first-tick verifies.
- **Known class + likely cause:** this is the documented step1 cost class. Ledger 2026-07-13 root-caused an identical step1 staleness to **index bloat on `idx_wmc_cohort_cover` (wallet_address, collection_id) INCLUDE (fmv_usd)** — the index-only-scan input bloated ~4.5× from wmc churn; a plain `REINDEX INDEX public.idx_wmc_cohort_cover` (non-concurrent one-shot at a quiet minute) took it 856s→54s with no query/timeout change. Two years of wmc churn later, the index has very likely re-bloated. ⚠ Do NOT just widen the timeout (proconfig `statement_timeout` is inert on the pg_cron path; the binding value is `cron_heavy`'s role default) — the 07-13 fix was the REINDEX, not a ceiling raise.
- **Risk read:** LOW to ship-nothing tonight (chronic, non-user-critical surface). The fix (REINDEX) is a known, behaviour-preserving one-shot but takes a brief write-stall on wmc, and 23:10Z is Pacific afternoon — the daytime ACCESS-EXCLUSIVE `TRUNCATE`-lock trade the 08-18/08-21 filings flagged still applies. Trevor's call on timing.
- **Suggested action (nightly):** (a) re-measure `idx_wmc_cohort_cover` bloat (`pg_relation_size` vs the plain 2-col equiv) in a quiet window to confirm the 07-13 recurrence; if bloated, REINDEX it via a self-cleaning pg_cron one-shot at a quiet minute (non-concurrent — CONCURRENTLY can't run under pg_cron's txn wrap). (b) consider the additive `cross_collection_cohort_stale_hours` trust-health arm (breach ~26h) so this stops being invisible between first-tick verifies — the monitoring-gap decision the 08-25 filing already proposed for the overlap mat, now clearly warranted for the cohort mat too. Measure before acting.

## Not re-filed (recorded for continuity, no action)
- Chronic statement-timeout / upstream-timeout pipeline_alerts (lock-check-batch, fmv-backfill, price-snapshots R100, run-insider-detectors, backfill-pack-rip-metadata) — 2-day rates POOLED across the 09-18 outage; split on the 19:01Z change point before quoting. Documented M11/#42/#73/#84.
- `backfill-pack-rip-metadata` + `lock-check-batch` `running_but_not_succeeding` arms — same timeout class; last runs 02:53Z / 02:38Z inside the brief spell now eased.
- Atlas 403 (editions + market feed) and flow-rest-moment-moved-400 — by-design upstream Cloudflare challenges / sold-moment panics, `info`, 0 sets stale.
- `sync-nba-projections` all_upstreams_failed — #8, measured dead, Trevor's.
- 1b artifact validation: the local artifact manifest (11 items) lives outside this session's connected folders, so the embedded payload HTML could not be read this tick; validated the DATA LAYER instead via rpc_ops_snapshot (security/trust/fmv/editions/pipelines all healthy) — the sources those artifacts read are green.
- Sentry dark by design (SDK removed, #34).
- 1a first-tick-of-day extras (trust health, cross-collection verify) not separately run — this is the ~8pm tick, not first-of-day; trust health came clean via the snapshot regardless.

---

## CORRECTION + RE-DERIVATION — appended 2026-09-18 ~9:50 PM PT (Cowork cloud). The filing's own words are left intact above.

A filed finding is a hypothesis. Every leg of the MEDIUM item above was re-derived from the DB before anything was shipped. **One leg holds, two do not, and the proposed fix is not the lever the 07-13 precedent makes it look like.**

### ✅ HOLDS — the staleness and its user surface
`rpc-ccm-step1` (jobid 60, `10 23 * * *`) **failed on 09-17 and 09-18**, both `canceling statement due to statement timeout` at **600.0 s / 600.1 s** on the `CREATE TEMP TABLE _ccm_step1_next` aggregate. `cross_collection_cohort_mat` was last written **2026-09-16 16:11 PT** (corroborated independently by `pg_stat_user_tables.last_autoanalyze`) ⇒ **53.5 h stale** at 21:40 PT 09-18. The only reader is the view `cross_collection_cohort_stats`, which backs the `/insights/cross-collection` cohort surface. ✅ The filing is also right that **no standing freshness arm covers it** — `board_mv_refresh_stale_hours` guards the board MVs, not this mat.

⚠ The 600 s ceiling is **not** the function's own `SET statement_timeout TO '180s'` proconfig — that is INERT on the pg_cron path (documented class). The binding value is the `cron_heavy` role default, and the observed 600.0 s durations confirm it.

### ⛔ REFUTED — "`rpc-ccm-step2` is FRESH … step1 is the specific failure"
`rpc-ccm-step2` **also timed out on 09-17** (300.1 s) and on **09-12** (300.0 s). Its 09-18 "success" took **110.3 s against a 13.5–36.7 s baseline** (09-11→09-16), i.e. **3–8×**. Both steps are degrading; step1 merely crosses its ceiling first. Treating step2 as healthy would have hidden half the signal.

### ⛔ REFUTED AS A SUFFICIENT CAUSE — index bloat on `idx_wmc_cohort_cover`
Bloat is **real but modest, and the arithmetic rules it out as the cause before any probe is needed**:

- Actual **321 MB** (`wallet_moments_cache`, 2,157,979 live rows). Expected for `(wallet_address text, collection_id uuid) INCLUDE (fmv_usd numeric)` at ~56–60 B/tuple and 90 % fill ⇒ **~130–146 MB** ⇒ **≈2.2×**, not the **4.5×** of the 2026-07-13 precedent.
- At this estate's measured **~22 MB/s IO burst floor**, 321 MB is a **~15 s** scan and a rebuilt ~140 MB index a **~6 s** scan. **A 2.2× bloat cannot take a 50.2 s run to >600 s.** A REINDEX buys ~9 s against a 550 s shortfall.
- ⛔ **It is also not a plan flip.** `EXPLAIN` on the step1 aggregate still returns the intended shape — `Index Only Scan using idx_wmc_cohort_cover` → `GroupAggregate`, no sort — so this is not the 08-25 nestloop class either.
- ⛔ **And the heap is clean:** `n_dead_tup` 28,156 (**1.29 %**), and the table already carries `autovacuum_vacuum_scale_factor=0.02` / `autovacuum_analyze_scale_factor=0.02` / `autovacuum_vacuum_insert_scale_factor=0.05`, with `autovacuum_count` 1,286 and the last autovacuum **45 min** before this reading. So the R101 visibility-map class is not obviously in play here — **but `Heap Fetches:` is UNMEASURED; see OWED.**

⚠ **A REINDEX is still defensible on its own merits** — 321 MB → ~140 MB on an index taking 13,506 scans / 84.2 M tuple reads — but it is an **optimisation, not this fix**, and it must not be shipped under this finding's banner or it will be credited with whatever happens next.

### ⛔ REFUTED — the adjacent "the wmc FMV drain is backlogged" story
`refresh_wmc_fmv_changed(30, 200000)` was caught mid-run at **195 s on DataFileRead**, which invites the conclusion that its cursor is behind and it is churning wmc. **It is not.** `rwfc_state.last_cutoff` lag is **11.8 min** — one cadence — with **509 pending editions**. The 2026-08-30 "~50 min behind" state recorded in the function's own comment **is fixed and has stayed fixed**. Its long ticks are it being an IO *victim*, not a backlog.

⚠ **But its OCCUPANCY is a real capacity fact, recorded here as an observation and NOT as a cause:** on 09-17 `rpc-refresh-wmc-fmv-changed` (`7-57/10`) consumed **444.3 min** — **31 % of the day**, worst tick **531 s of a 600 s cadence** — and `rpc-allday-unmapped-atlas-resolver` (`4-59/5`) consumed **352.8 min**. Together **~55 % of wall-clock** on a 2-core SMALL instance. On calm 09-15 the same two cost **50.8 + 73.4 min**. They rise and fall *with* everything else, so this is correlation; it is written down because a lane sized to occupy 89 % of its own cadence on a bad day has no headroom by construction.

### 📏 WHAT THE EVIDENCE ACTUALLY SUPPORTS — contention, with one measured lever
- **Whole-estate daily control.** 09-17 was the worst day in nine: **793 failed / 692 timeouts, avg 24.53 s, p95 120.04 s**, against calm 09-16 (**87 / 76, avg 7.02 s**). step1 ran **50.2 s** on 09-16 and timed out on 09-17. ⚠ But 09-18 was only middling (**150 / 126, avg 11.15 s**) and step1 **still** timed out — so ambient load alone does not close the case.
- **Same-window control**, 16:05–16:30 PT, 165 runs each day: 09-10→09-16 **avg 3.4–7.7 s, 0–1 timeouts**; **09-17 avg 43.34 s / 25 timeouts**; **09-18 avg 21.34 s / 3 timeouts**.
- 🚨 **DO NOT QUOTE THAT WINDOW AVERAGE AS step1's CAUSE.** step1's own 600 s run is **inside** it. Your own probe is the load — here the suspect is a member of the population it is being measured against, so "the window was busy" and "step1 was slow" are not independent observations.
- **Hour-of-day profile**, 7 days, PT, with a flat population (~2,650–2,790 runs in *every* hour, so this is not a scheduling-density artefact):

  | hour PT | busy-min/7d | timeouts | avg s |
  |---|---|---|---|
  | **16 (step1 today)** | **477.6** | **66** | **10.81** |
  | 1 | 300.9 | 21 | 6.63 |
  | 2 | 316.5 | 24 | 6.98 |
  | 3 | 309.3 | 21 | 6.84 |
  | 11 (worst) | 1,357.6 | 194 | 29.45 |

### 👉 SHIPPED THIS PASS — the reschedule, justified independently of the root cause
`rpc-ccm-step1` **`10 23` → `2 10`** and `rpc-ccm-step2` **`25 23` → `35 10`** (UTC), i.e. **4:10/4:25 PM PT → 3:02/3:35 AM PT**. Rationale, and note that **both legs stand on their own regardless of what the OWED probe returns**:

1. **~35 % less ambient load and ~64 % fewer ambient timeouts** at the destination hour, on the flat-population profile above.
2. ⭐ **It moves an `ACCESS EXCLUSIVE` `TRUNCATE` on a reader-facing table out of the Pacific business afternoon** — the daytime-lock trade the 08-18/08-21 filings flagged, and the exact thing the filing above left as "Trevor's call on timing". At 3 AM PT there is no call to make.
3. **It widens the step1→step2 gap from 15 min to 33 min.** Today's gap is *narrower than step1's own 600 s ceiling*: a step1 that runs to its budget finishes at 23:20Z, five minutes before step2 starts. That latent collision is removed, not merely moved.
4. **Destination minutes were chosen against the live `cron.job` table, not a doc.** 10:02Z/10:35Z are clear of every daily neighbour (next is 10:51Z) and of the Sunday-only `rpc-weekly-wmc-prune` at 10:20Z +600 s — which matters because **step2 sequentially scans `wallet_moments_cache`** and the prune deletes from it.

⛔ **Deliberately NOT done:** no timeout widened (the filing is right — and the proconfig is inert anyway), no REINDEX, no data touched, no function body changed.

### 🔬 OWED — the one measurement that decides between the remaining hypotheses
`EXPLAIN (ANALYZE, BUFFERS)` on step1's aggregate in a genuinely quiet window, bounded by `SET LOCAL statement_timeout` so the probe cannot run away. **`Heap Fetches:`** separates the R101 visibility-map class from pure contention; **buffers** separate bloat from both.

⛔ **Not taken this pass, and the reason is the finding's own discipline:** the DB sat at **io_wait 8–10 / active 9–11** for the whole pass, with `REFRESH MATERIALIZED VIEW CONCURRENTLY allday_special`, `refresh_topshot_special_serial_owners_mv`, `reconcile_wmc_metadata_from_editions(1200, 45)` and the 195 s wmc drain all in flight. **A 321 MB index-only scan launched into that would have been the load, and its number would have described me.**

### ⚠ CHANGE POINT — for whoever reads step1/step2 next
The reschedule applies **2026-09-18 ~10 PM PT**. Any success/failure or duration rate for jobids 60 and 4 that spans it is **pooled across a change** and measures the change's absence. Split on it. The pre-change record is: step1 16.6/36.7/25.7/50.2 s (09-13→09-16) then **timeout, timeout**; step2 13.5/16.2/36.5/28.8 s then **timeout (09-17), 110.3 s (09-18)**.

**Falsifier for the reschedule:** if step1 times out again at 10:02Z on a day whose *whole-estate* 09:55–10:40Z window averages under ~8 s (i.e. a calm destination), the reschedule is refuted as sufficient and the cause is intrinsic to the query — go take the OWED probe and re-open the REINDEX/restructure branch. **No-change control:** `rpc-allday-unmapped-atlas-resolver` was not touched and shares the IO but not the table-access pattern; if *it* improves by the same margin over the same days, the improvement is the estate calming down, not this change.

---

## 🔬 THE OWED PROBE WAS TAKEN — and it REFUTES the reschedule as sufficient. My own falsifier, fired the same night. (appended ~10:20 PM PT 09-18)

A quiet window opened at **21:57 PT (io_wait 2 / active 3)** and the probe the section above listed as OWED was taken. **It does not support the contention story.**

### The instrument was controlled first
`set statement_timeout = '100s'; select pg_sleep(20) …` returned with `current_setting('statement_timeout')` = **`100s`** and the sleep completed. So the bound was genuinely in force and every cancel below is a real timeout, not a shorter default firing underneath me.

### What the probes returned
| probe | bound | result |
|---|---|---|
| full step1 aggregate | 110 s | **cancelled** (ran 50.2 s on 09-16) |
| same aggregate, 1/16 of the `wallet_address` keyspace | 100 s | **cancelled** |
| bare `ORDER BY wallet_address, collection_id LIMIT 200000` (index-only, no aggregate) | 60 s | **cancelled** |
| same, `LIMIT 5000` | 55 s | **completed in 19,236 ms** |

The one that completed is the one that says why:

```
Limit (actual time=0.125..19235.875 rows=5000 loops=1)
  Buffers: shared hit=328 read=1894 dirtied=25 written=473
  ->  Index Only Scan using idx_wmc_cohort_cover on wallet_moments_cache
        Heap Fetches: 2407
Execution Time: 19237.937 ms
```

⛔ **`Heap Fetches: 2,407` on 5,000 rows — 48 %.** The index-only scan is not index-only. And **2,222 buffers in 19.2 s is ~10 ms per buffer**: this is random single-page heap I/O, *not* a volume problem. **That is why bloat could never have been the cause** — the cost is per *fetch*, not per megabyte, so shrinking the index 321 MB → 140 MB moves almost nothing.

### ⚠ CONTAMINATION, stated because it bounds the claim
`autovacuum: VACUUM public.wallet_moments_cache` was running during the 5,000-row probe (pid 70551 — later measured at **239 s in, 87.2 % of heap scanned, 439 blocks/s ≈ 3.5 MB/s**, i.e. cost-throttled, and still running at **457 s**). It was **not verified absent** during the 110 s and 60 s probes. **So the magnitude above is contaminated and must not be quoted as a clean number.** What is *not* contaminated is the direction: a **110 s failure at io_wait 2 against a 50.2 s success three days earlier** is not explicable by ambient load.

### 📏 The free, uncontaminated instrument agrees — and it has a built-in control
`relallvisible / relpages`, straight from `pg_class`, needs no probe and costs nothing:

- `wallet_moments_cache` — **103,213 / 120,286 = 85.8 %** all-visible
- `topshot_atlas_market_events` — **87,873 / 88,169 = 99.7 %** all-visible

⭐ **These two are the control pair.** Same order of size (2.16 M vs 2.41 M rows; 120 k vs 88 k pages), **the same `autovacuum_vacuum_scale_factor=0.02`** — atlas got it earlier the same night, wmc already had it — and yet wmc's not-all-visible share is **14×** atlas's. **The knob is not the difference.**

### 🔬 LEADING HYPOTHESIS — stated as a hypothesis, not as established
The difference between the pair is **UPDATE churn vs INSERT churn**. `wallet_moments_cache` is rewritten in place by `refresh_wmc_fmv_changed`; `topshot_atlas_market_events` is appended to. A page holding a recently-updated tuple **cannot be marked all-visible while any snapshot older than that tuple is still open** — and this estate holds transactions open for minutes continuously (the FMV drain at **195–531 s**, the atlas syncs at **300–600 s**). On that account a vacuum can run hourly, as wmc's does (`autovacuum_count` 1,286), and still never get the visibility map clean, because `OldestXmin` is permanently held back.

⛔ **Not established.** The decisive test is `pg_visibility.pg_visibility_map_summary` before and after a `VACUUM (DISABLE_PAGE_SKIPPING)` taken with **no long transaction in flight** — and the whole point is that such a moment may not exist on this estate, which would itself be the finding. **Not run tonight** (see the stop note below).

### ⇒ CONSEQUENCE FOR THE RESCHEDULE — read this before closing anything
**The cohort lane will very likely still fail at 10:02Z.** The reschedule's remaining value is its **two independent legs**: the daytime `ACCESS EXCLUSIVE` `TRUNCATE` is out of the Pacific business afternoon, and the step1→step2 gap is wider than step1's own ceiling. 🚨 **Do NOT mark this item resolved when the lane moves**, and do not credit the move with a recovery it did not cause. The falsifier in the section above is now **pre-fired**: treat a 10:02Z timeout as expected, not as new information.

### ⛔ WHY NOTHING FURTHER WAS SHIPPED OR PROBED TONIGHT
At **22:13 PT** the estate went to **io_wait 29 / active 36** (of `max_connections` 90) with **27 PostgREST requests stacked on IO, oldest 112 s** — user-facing request queuing, alongside the 457 s wmc autovacuum and a 285 s FMV drain tick.

🚨 **I cannot exonerate my own probes for that, and will not pretend otherwise.** They ended roughly ten minutes earlier, they did sustained *random* heap I/O against a hot 940 MB table, and the `LIMIT 200000` probe in particular will have evicted a large working set. The PostgREST pile-up began after them. Whether it is my cache pollution, the throttled autovacuum, or the ordinary evening steady state is **not separable from here** — which is exactly why the honest move is to stop, not to take one more reading to find out.

**So: probing stopped, and the second migration this pass had ready was held.** What it carries is recorded below as owed.

### 📋 OWED, in priority order
1. ~~**`rpc-ccm-step2-retry` (jobid 491) must move.**~~ ✅ **DONE 22:25 PT, migration `20260919061000` — moved to `47 15 * * *`, still INACTIVE.** The description below stands as the record of why. It is `37 4 * * *` and **currently inactive** (a ledger-recorded pause), and its body is self-guarding: it runs step2 only if `cross_collection_ts_set_overlap_mat` is older than **12 h**. ⛔ **The reschedule shipped tonight broke that guard's arithmetic**: with step2 now at 10:35Z, the mat is **18 h 02 m** old at 04:37Z, so a re-enabled retry would fire **every single day** instead of only after a failure — a 300 s step2 added to 9:37 PM PT. **This is a landmine I created.** Proposed destination **`47 15 * * *`** (15:47Z = 8:47 AM PT): ~5 h 12 m after step2, restoring the original margin, and **UTC hours 15 and 16 hold no daily jobs at all** (checked against the live `cron.job` table). ⚠ It is inactive, so there is no live impact today — but it must be fixed before anyone re-enables it.
2. **A freshness arm on `cross_collection_cohort_mat` age** (the monitor's own §(b), now clearly warranted — 53.5 h passed with nothing alarming). ⛔ **Deliberately not shipped:** the arms live in a single ~50 KB `UNION ALL` inside `v_rpc_trust_health`, so adding one is a **full-body `CREATE OR REPLACE`** of the platform's trust surface. That is not an unsupervised change. Shape it as `cross_collection_cohort_stale_hours`, `breach_at` ≈ **26** (daily cadence ⇒ healthy maximum gap ~24 h — size it from the TRUE cadence, which is the lesson the 0011Z filing paid for).
3. **The `pg_visibility` test above**, and only then a decision on whether `wallet_moments_cache` needs a structural answer (the UPDATE-in-place drain is the thing to look at, not the index).
4. ⚠ **`idx_wmc_cohort_cover` REINDEX is NOT on this list as a fix.** It is a defensible tidy-up on its own merits and nothing more; the probe shows the cost is per heap fetch, not per megabyte.


---

## 🔬 CLEAN RE-PROBE — appended 22:52 PT

🔬 **CLEAN RE-PROBE ON AN IDLE BOX, 22:45 PT — the contamination caveat was right, and the surviving number is worse news than the contaminated one.** Re-ran the identical `LIMIT 5000` index-only probe with **io_wait 0 / active 1** and **no vacuum on the table**: **`Heap Fetches: 1,833` of 5,000 (36.7 %), `Buffers: hit=375 read=1319 dirtied=243`, Execution 3,770 ms** — against the contaminated **19,236 ms / 2,407 fetches**. ✅ **5.1× faster, so the earlier magnitude WAS contamination, exactly as flagged — and the structural finding survives it intact:** still **36.7 % heap fetches**, still **2.86 ms per block read**, and the scan still **dirties pages as it reads** (243), because each heap visit does hint-bit work. ⚠ **Extrapolated to all 2,157,979 rows that is ≈ 27 minutes ON A COMPLETELY IDLE BOX, against a 600 s ceiling — so step1 cannot complete even with the estate to itself.** The reschedule's falsifier is now pre-fired twice over. 📏 **And the free instrument moved while I watched: `wallet_moments_cache` all-visible fell 85.8 % → 75.4 % in ~50 minutes** (`relallvisible/relpages`, no probe, no cost). **The map is rotting faster than the hourly autovacuum repairs it** — that last vacuum ran 457 s and only reached 85.8 %. ⭐ **That is the mechanism showing itself in real time, and it is the single cheapest number for the next session to re-read.**
