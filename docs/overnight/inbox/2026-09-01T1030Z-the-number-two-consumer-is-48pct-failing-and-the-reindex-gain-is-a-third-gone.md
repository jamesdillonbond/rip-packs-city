> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T1030Z — the instance's #2 consumer fails 48% of its calls, and the REINDEX that was supposed to relieve it lost a third of its gain in 30 hours

**Pass:** cloud (no device bridge), fired 10:18Z by `trig_018AyNcnbCZuYb1Ztts6rbBR`. **DB `now()` 10:19:15Z = 03:19 PT.**
**Repo:** `origin/main` **355b01d1**, fresh `--depth 200` clone read 10:19Z — the concurrent session brought nothing new since the 0859Z pass.
**Shipped: nothing.** Migrations 0, edge deploys 0, cron changes 0. Two findings, one of which corrects an item this repo has booked as CLOSED.

---

## 1. 🚨 `refresh_seeded_wallet_stats` — 294 of 607 calls (48.4%) fail, and every instrument on this platform is blind to it

Found by repeating the sweep that caught `enrich-ufc-wallet` 12 hours ago: **rank the diff by cost, then ask the
separate question of whether the top items are also FAILING.** They were, again.

`edge_logs`, 24 h to 09-01 10:29Z, `/rest/v1/rpc/refresh_seeded_wallet_stats`, service_role / `supabase-js-node/2.104.0`:

| hour (UTC) | 500 | 204 | fail rate |
|---|---|---|---|
| 08-31 12Z | 0 | 2 | 0% |
| 08-31 13Z | 9 | 12 | 42.9% |
| 08-31 20Z | **141** | 112 | **55.7%** |
| 09-01 00Z | **114** | 94 | **54.8%** |
| 09-01 01Z | 11 | 7 | 61.1% |
| 09-01 07Z | 0 | 16 | 0% |
| 09-01 08Z | 19 | 70 | 21.3% |
| **total** | **294** | **313** | **48.4%** |

**The error, read from `postgres_logs` rather than inferred:** `canceling statement due to statement timeout` —
**257 occurrences of that exact PostgREST wrapper** in the 19:30Z→01:00Z window alone, third by volume across the
whole instance in that window.

**Why nothing saw it.** ⓘ The function writes **no `pipeline_runs` row**, so `detect_stalled_pipelines()` and
`get_pipeline_alerts()` are both structurally blind. Sentry has been dark since the 08-18 quota exhaustion. And the
saturation instrument ranks it by **cost**, which is exactly what the 0859Z pass measured — that pass decomposed
`holdings_summary` to the buffer and never looked at a status code. ⭐ **A cost ranking cannot tell you a query is
failing; this is the second consumer in twelve hours where that gap hid a live defect.**

**Product effect, measured rather than asserted** (`seeded_wallets`, 274 rows, 10:32Z):

| | n | avg cached_moment_count | max |
|---|---|---|---|
| refreshed < 24 h | 204 | 8,422 | 73,842 |
| stale 1-7 d | 47 | 5,943 | 27,446 |
| **stale > 7 d** | **15** | **15,619** | **154,237** |
| never refreshed | 8 | - | - |

**62 of 274 (22.6%) carry a cached moment count / FMV / top tier older than 24 h; the oldest is 138 days.**

⚠ **NARROWED, NOT CLOSED — and my first hypothesis is half wrong.** A 48% *independent* failure rate cannot produce
a 7-day gap: `0.48^7 ~= 0.6%`, i.e. ~1.6 expected wallets against **15 observed**, so the failures are correlated with
something. The obvious candidate is wallet size, and the >7 d bucket does hold **1.9x the mean holding of the fresh
bucket and the single largest wallet on the platform** — but the 1-7 d band is **smaller** than the fresh band, so
size alone does not order the staleness. ⛔ The settling test is **not** available from `edge_logs`: the wallet
address is in the POST body, not the URL, so per-wallet failure rates cannot be derived there. It needs the caller
instrumented, or a `pipeline_runs` row per call.

**Not fixed, and the reasons are specific, not effort:**
- The cost is **cold reads, not a bad plan** — established by the 0859Z pass (identical buffers cold vs warm, 48x
  the wall clock) and unchanged today. Statistics are fresh (`editions` and `fmv_snapshots_2026` analyzed 04:xxZ,
  `wallet_moments_cache` autoanalyzed 10:09:58Z), so this is **not** the `sales_2023` never-ANALYZEd class.
- The three plan-level candidates are **already tabulated dead ends**: dedup the LATERAL (12% on a median wallet,
  the 3.10 rows/edition ratio is whale-carried), point it at `edition_fmv_current` (⛔ refused on merit — up to ~3 h
  stale portfolio FMV on a user-facing surface, Trevor's product call), and widen the `fmv_snapshots_2026` covering
  index (⛔ refuted 0859Z by its own positive control, 3.4%).
- I costed the two legs the 0859Z pass did not, and both are marginal. The `editions` probe (17,621 buffers,
  3.97/row) reads `e.id` and `e.tier` through `editions_external_id_collection_id_key`, so a covering
  `INCLUDE (id, tier)` removes **one heap page per probe out of ~4** — ~11.5% of the function, on a table that took
  two new indexes 11 hours ago. The `refresh_seeded_wallet_stats` wrapper's own top-tier query re-reads every row of
  the wallet for `tier`, which `idx_wmc_cohort_cover` does not INCLUDE — and a tier covering index was already
  rejected for write amplification on a 2.5 M-row table.
- **The lever that actually addresses it is §2**, and §2 says wait one more pass.

---

## 2. 🚨 CORRECTION — item 14 (`wmc` REINDEX wave) is booked CLOSED. The build succeeded; the *gain* is a third gone in 30 hours

Item 14 closed on 08-31 04:06Z with `wmc-reindex-verify` `ok=true`, all four targets >= 60% leaf density, ~237 MB
reclaimed in the second wave. Re-read with the **same instrument** (`extensions.pgstatindex`, what the verify calls):

| index | 08-30 03:09Z (pre) | 08-31 04:06Z (post) | **09-01 10:24Z (now)** |
|---|---|---|---|
| `idx_wmc_cohort_cover` | 614.4 MB / 22.53% | 146.8 MB / 90.32% | **281 MB / 47.88%** |
| `idx_wmc_coll_ek_serial_cover` | 498.5 MB / 28.27% | 168.5 MB / 81.67% | **278 MB / 49.91%** |
| `idx_wmc_moment_collection_cover` | 314.3 MB / 41.55% | 149.1 MB / 86.38% | **243 MB / 53.41%** |
| `wallet_moments_cache_wallet_collection_moment_key` | 313.1 MB / 48.71% | 165.3 MB / 90.61% | **194 MB / 77.49%** |
| **total** | **1,740.3 MB** | **629.7 MB** | **996.0 MB** |

**The wave reclaimed 1,110.6 MB. 366.3 MB (33.0%) is back in 30 h 18 m** — on an instance with
`shared_buffers = 512 MB`, whose top three consumers are all cold reads of this table.

⭐ **This is page-level bloat, not table growth, and the check is internal to the numbers.** If the entry population
were flat, size should scale as the inverse of leaf density. Predicted-from-density vs actual: cohort 276.9 vs 281
(1.5%), coll_ek_serial 275.7 vs 278 (0.8%), moment_collection 241.1 vs 243 (0.8%), the unique key 193.3 vs 194
(0.4%). **All four within 1.5%.** The pages are half-empty; the rows are the same rows.

**Mechanism, already recorded and now quantified:** the `*_cover` indexes carry `fmv_usd` / serial payloads, so every
FMV write is non-HOT for them. Live counters: `n_tup_upd = 46,606,911`, `n_tup_hot_upd = 2,123,690` — a **4.6% HOT
ratio**. 95.4% of updates insert a new entry into all 18 indexes, and autovacuum can delete b-tree entries but
cannot merge half-empty pages.

⛔ **I did NOT reindex this pass, deliberately, and that is the finding's whole point.** Two readings are not a rate.
The decision that matters is the *cadence*, and it turns entirely on whether density **asymptotes near ~50% or keeps
falling toward the 22% it reached before**. Rebuilding now resets the clock and destroys the only measurement that
can answer it. A pass runs every 2 h and the query is one line — **let three or four more points land first.**

⚠ Also worth recording against the "unused index" reflex: there is **no** dead weight to drop here. All 18 wmc
indexes show non-zero `idx_scan` against a `pg_stat_database.stats_reset` of NULL and a postmaster up since
2026-06-12; the lowest is `idx_wmc_locked_count` at 102 scans / 4 MB.

**DECAY LOG — append one row per pass** (`pgstatindex`, MB / avg_leaf_density):

| read at (DB `now()`) | cohort | coll_ek_serial | moment_coll | unique key | total |
|---|---|---|---|---|---|
| 2026-08-31 04:06:00Z | 146.8 / 90.32 | 168.5 / 81.67 | 149.1 / 86.38 | 165.3 / 90.61 | 629.7 MB |
| **2026-09-01 10:24:2xZ** | **281 / 47.88** | **278 / 49.91** | **243 / 53.41** | **194 / 77.49** | **996.0 MB** |

⭐ Cheapest way to take a point (no REINDEX, ~4-40 s depending on how bloated the indexes are, writes its own
`pipeline_runs` row): `select public.run_wmc_reindex_verify();` — it is measure-only since
`audit_20260830_run_wmc_reindex_verify_measures_only_unschedule_moves_to_the_cron_command`. ⚠ It returns
`ok=false` whenever any target is under 60% leaf density, which is **true today by design**, so do not schedule it
on pg_cron without first deciding what a permanently-red `wmc-reindex-verify` arm should mean.

---

## 3. Post-ship watches

- **`enrich-ufc-wallet` v47 (deployed 08:31:42Z) — STILL UNEXERCISED, and the tempting reading is wrong.**
  Snapshot-to-snapshot on the exact `queryid 1387451210050502049` (08:32:04Z -> 10:22:48Z, full
  `(userid,dbid,toplevel,queryid)` key): **3,042 -> 3,042, `d_calls = 0`, `d_read = 0`.** A `pgrst_source` queryid
  wrapping `get_fmv_snapshot_for_editions` **still does not exist**. ⚠ `edge_logs` shows `/rest/v1/fmv_snapshots`
  500s at **362 before the deploy and 0 after** — do **not** book that as the fix landing: the 200s went 420 -> 2 in
  the same split, i.e. **the caller has not run**, last invocation 08:15:17Z. Watch stays OPEN on its original exit.
  **FALSIFIER RE-CHECKED AND CLEAR:** UFC `wallet_moments_cache` rows with NULL fmv against a priced edition =
  **0 of 5,455** (149 wallets, 485 genuinely-NULL snapshots) — the 08:18Z and 08:59Z baselines, unmoved.
- **`analytics_smoke_run` clock-gated drift check (20260901051746) — HOLDING.** 06:05->10:22Z diff: **8 calls,
  40,131 blocks/call, 25,062 ms/call** against the 05:43Z post-ship reading of 38,143 / 25,652. Was 70,019.
- **`refresh_wmc_fmv_drift_active` (26-wallet fence) — HOLDING with n=51.** 209,175 blocks / 51 calls =
  **4,101 blocks/call**, against the 08:00Z exit reading of 4,246 over 33 calls and 30,993 pre-ship.
- **Item 11 dead host — still dead, probed this pass with a positive control.**
  `public-api.nbatopshot.com/graphql` **530 on 3 of 3**; control `nbatopshot.com` **200**. Nothing re-enabled.

## 4. Health

🟢 **GREEN.** Security `check_public_security_invariants()` `[]`, `check_anon_write_surface()` `[]`,
`check_secdef_anon_execute_violations()` `[]`, `check_secdef_anon_exec_drift()` `[]` — values read, not row counts.
`detect_stalled_pipelines()` `[]`. `get_pipeline_alerts()` = **3**, one fewer than 0859Z (the AllDay
`cron_silent` EarlyDrop false-positive has aged out); the rest known/structural. Trust health **2 breaches, neither
a regression** (`public_board_slow_count` 1, planner-pruned instrument; `unmapped_resolution_backlog_max` 225 vs
breach_at 100, structural — do NOT raise it). All 19 precompute legs fresh, max age 5.58 h vs the 13 h arm.
**pg_cron: zero non-`succeeded` runs in 24 h across 106 jobs.** Vercel production 12 h: **21,630 requests, 4 x 500
(0.018%), 59 x 502** (the characterised IPFS-gateway class), 2 x 504, 1 x 503.
**Migration parity GREEN, derived fresh and BY NAME** — md5-prefix anti-join, 205 distinct names applied in the
14-day window against all 815 committed filenames (14-digit stamp stripped): **0 fileless.** The 0818Z and 0859Z
cloud passes applied no migration, so nothing was stranded by them.
