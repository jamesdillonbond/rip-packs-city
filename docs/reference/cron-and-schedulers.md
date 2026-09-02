<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## ⭐ SCHEDULER POPULATION — re-derived live 2026-08-27 20:45 PT (supersedes every count below)

Both figures below are stale and the direction is the same both times — **up**. Count them; never quote them.

| surface | 2026-08-27 | previously recorded |
|---|---:|---|
| `cron.job` total / active | **100 / 100** | 93 active (08-16), "99 active" (08-26) |
| `cron.job` owned by `cron_heavy` | **45** | 42 of 93 (08-22) |
| `vercel.json` cron entries | **35** | 36 (08-22), 37 before that |

⚠ **The `cron_heavy` share is the number that decides what a session can DO, not the total** — `postgres`
may EXECUTE those jobs but does not own them, so **no session-reachable role can reschedule 45 of the 100**.
Read `cron.job.username` before planning any `cron.alter_job`; the recipe that works (`SET LOCAL ROLE
cron_heavy`, probe in a rolled-back `DO` block, `RESET ROLE` before `apply_migration` writes its own row)
is recorded further down this file.

⚠ **The Vercel count went DOWN by one, and that is a retirement rather than a miscount this time:**
`compute-laliga-pack-ev` was removed on 2026-08-27 after writing **zero rows in its entire life** (20 runs,
`sum(rows_written) = 0`) — and its being broken had been *preventing* a `fmv_usd: 0` sentinel from
publishing $0 as a real price for hundreds of Golazos editions. ⭐ **The lesson generalises past this job:
when a broken feature has never produced output, establish what it WOULD have produced before repairing
it** — repair was the obvious move here and it was the wrong one.

⚠ **`candy-editions-ingest` moved `10 22 * * *` → `10 1 * * *` the same night** (~45% of nights killed at
22:10Z; production deploy READY 2026-08-28 03:11Z). **First run at the new slot is 2026-08-29 01:10Z**, so
its cadence arm reads BREACH across ~51 h of transition — expected, not a new fault. Register: #47.

## 🚨 GITHUB ACTIONS IS ONE OF THE FOUR, AND IT HONOURS ROUGHLY 5 RUNS PER WORKFLOW PER DAY (2026-08-29)

Read this before planning ANY cadence on a `.github/workflows/*.yml` schedule, and before trusting a
figure derived from one.

Measured across 17 scheduled workflows in a single 24 h window: **observed ≈ `min(expected, 5)`**.
Eight workflows asking for **24–96 runs/day all received 4–6 (mean 5.0)**, with no relationship to
whether they asked for 24 or 96. `offer-fill-backfill` asks for **96 ticks and gets 5**.

⛔ **So raising a GHA cadence buys nothing above ~5/day, and a cron that states more is a FALSE DOCUMENT**
the next reader will trust. Either move the schedule to cron-job.org — which is not subject to this and
already drives the production pipelines reliably — or rewrite the cron to state what it actually gets.

⚠⚠ **CORRECTION 2026-08-29 — `min(expected, 5)` IS THE WRONG SHAPE, and the sentence above is a MODEL
fitted to one 24 h window (n = 17, one sample).** Re-derived from the 30 scheduled `rpc-pipeline` runs
GitHub still lists, 2026-08-26 → 08-30:

| UTC day | scheduled runs |
|---|---|
| 08-26 | **18** |
| 08-27 | 2 |
| 08-28 | 3 |
| 08-29 | 6 |

**Eighteen runs in a day refutes a cap of five outright.** Inter-run gap over that span: **median 1.81 h ·
p90 9.92 h · max 11.35 h**. So the shedding is **erratic, not clamped** — the practical advice above
(don't state a cadence you don't get; prefer cron-job.org for anything load-bearing) is UNCHANGED and
still correct, but ⛔ **do not quote `min(expected, 5)` as a mechanism, and do not derive a threshold
from it.** A watchlist `max_silent_minutes` must come from the observed MAX GAP, not from a runs/day
model: `audit_20260830_watchlist_rpc_pipeline_endpoints` uses **1800 m = 2.6× the 11.35 h max**.

⚠ **The general lesson is the one worth keeping: a rate model fitted to ONE window is a hypothesis about
the window.** The original reading is not "wrong" about what it saw — eight workflows really did get 4–6
that day — it is wrong about what that implies. **A directional claim needs a DISTRIBUTION** (CLAUDE.md),
and this is the same rule applied to a scheduler instead of a database.

⛔ **"~92% shed" is the wrong summary statistic**: it is 95% for a 96/day cron and **0% for a daily one**,
and the three 1/day workflows measured got 1 of 1. Daily schedules survive; that is why
`scheduler-liveness.yml` runs daily rather than hourly — an hourly liveness check would be shed by the
very thing it watches.

⚠ **A dropped tick emits NO run, NO badge and NO email.** The workflow still reads `active` and its last
run still reads `success`. Nothing anywhere says the alarm did not fire.

👉 The mechanism is NOT established: a per-workflow cap and a per-repo budget (the repo requests 561
runs/day) are indistinguishable in one window. **Discriminator:** disable a few high-frequency workflows
and see whether the others RISE (budget) or hold at ~5 (cap).

Derivation, the gap distribution, and the detector: [testing-and-ci.md](testing-and-ci.md).

## Cron / scheduler surfaces (4 independent schedulers)

Scheduled work spans **four** schedulers, not one — verified live 2026-07-06, all green (`detect_stalled_pipelines()` = `[]`, `check_pgcron_recent_failures()` = `[]`):

- **cron-job.org** — ~33 HTTP-triggered pipelines, `*/20` cadence dominant (sales-indexer→AllDay-unmapped-resolver chain, HybridCustody events, ingest). The external console is operator-only; cron entries aren't enumerable from the repo.
- **GitHub Actions** — 20 workflows (`.github/workflows/`), **17 scheduled** (verified 2026-08-09: rpc-pipeline, ops-monitor, pipeline-sentinel, allday-ingest, badge-sync, pinnacle-owner-discovery, topshot-active-listings-ingest, smoke-tests, e2e-smoke [Playwright rendered-DOM monitor, every 6h], db-pin-staleness [daily DB-pin drift check, 07:20 UTC — moved weekly→daily 2026-08-10], **edge-fn-drift** [repo↔deployed edge-fn drift comparator, daily 06:40 UTC — added 2026-08-07 in `5e17a755`], **migration-parity** [prod-applied migrations vs committed files, daily 07:40 UTC — added 2026-08-09; REPORTS, does not fail, see its header], the *-backstop jobs, …). ⚠ **`edge-fn-drift` HAS FAILED EVERY SCHEDULED RUN SINCE AT LEAST 2026-08-09 AND THAT IS THE WORKFLOW WORKING — `exit 1` IS "drift found" (2026-08-16).** It correctly reported **26 proven-drifted functions** daily, naming `snapshot-institutional-wallets` in the list the whole time, while that function ran ~7-week-old code that was fabricating 161k rows. **The instrument was loud and correct; the signal was not read.** A permanently-red scheduled workflow is indistinguishable from a broken one at a glance, which is exactly how it got ignored — check its LOG, not its badge. Baseline at arming was 31 proven-drifted of 37; 26 on 08-16; **25 after the v28 deploy**. ⚠ **AND THERE ARE TWO DIFFERENT SUPABASE PATs — do not conflate them.** The repo secret this workflow uses is VALID (it listed 67 deployed functions that same run); the token in Trevor's local shell is REVOKED and 401s every `supabase` CLI call. A CLI failure says nothing about the workflow's credential, or vice versa. The **3 without a `schedule:` trigger** are `ci.yml` (runs on push) plus `allow-list-reconcile.yml` + `topshot-listing-cache.yml` — both deliberately migrated to **Vercel crons** (GHA was silently dropping ~60–83% of their schedule ticks) and kept as manual `workflow_dispatch` backstops only. No `alert-checker.yml` exists — health-alert dispatch is cron-job.org → `/api/check-alerts` + `/api/sentinel`.
- **Vercel crons** — **36 entries** (⚠ re-derived live 2026-08-22 — this read **37** and was stale by one; count it, do not quote it) in [vercel.json](../../vercel.json) (2026-08-16 retired the `topshot-flowty` pair — `topshot-flowty-unmapped-drain` `9,29,49 * * * *` + `topshot-flowty-sales-history-backfill` `27 */3 * * *` — taking 39→37. ⚠ **They were COMPLETE, not broken, and the routes are KEPT** (schedule-only retirement, the `sync-sales-ingest-dune` disposition): the producer's cursor sits at exactly `SPORK_FLOOR_HINT` (137,390,146) reporting `reached_spork_floor_hint`, unmoved since 08-04, and it walks BACKWARD so it can never yield another row; the consumer's queue is **24,583 of 24,583 resolved, open population ZERO**. ⚠ The saving is real: **no index matches the drain's `ORDER BY ingested_at ASC` under those filters**, so proving emptiness scanned the whole Top Shot open backlog on every one of ~73 daily ticks — **8–19 of them died on `canceling statement due to statement timeout`**, i.e. ~860 no-op invocations and ~100 timeouts since 08-05 on the IO-throttled instance. **An empty result is the most expensive case**, the same mechanism `lib/unmapped-rotating-window.ts` documents. ⚠ This does NOT abandon the deep 2022→2025-12-29 Flowty tail, which sits BELOW the spork floor and always needed `spork-proxy` — a separate gated workstream, unaffected. Earlier: 2026-08-16 added `/api/smoke-test` `17 */4 * * *`, taking 38→39 — ⚠ **the smoke SUITE itself had no guaranteed cadence**: `smoke-tests.yml` fires on `push` + ONE daily schedule, and 7 days of smoke rows (one per tick, so a complete census) showed a **4.5–9.3 h window with no smoke run EVERY single day** (08-13: 556 min), and the driver is confirmed 1:1 — in 2026-08-17 hour 00 UTC there were **14 GHA runs, ALL `push`**, against **15 smoke ticks**, each landing ~1 min after its run. **Every smoke tick is a push run; there is no cron caller at all.** (Daily tick-vs-commit counts look only weakly correlated and are the WRONG instrument — `git log --all` counts branches that never triggered anything; compare run timestamps, not daily totals.) Vercel cron rather than GHA because GHA drops ~60–83% of scheduled ticks here. ⚠ **The hours are 0,4,8,12,16,20 — deliberately NEVER 9** — because `wantsLiveConcierge()` turns ANY tick inside 09:00–09:24 UTC into a PAID Anthropic call, so an innocent-looking change to `*/3` would silently re-add a second paid probe/day without touching any concierge code; pinned (with the `GET`-export and `CRON_SECRET` traps) by `__tests__/smoke-test-has-a-guaranteed-cadence.test.ts`; 2026-08-13 added `/api/cron/topshot-catalog-backfill` `12 2 * * *`, taking 37→38 — the scheduler-facing wrapper that finally puts the Top Shot catalog walker on a schedule; see the `editions.description` bullet for why a `vercel.json` line pointed straight at the admin route would have 401'd every tick; 2026-08-09 added `/api/cron/refresh-insights-cache` `*/5 * * * *` — the single WRITER of the PUBLIC-BOARD-CACHING snapshot cache, taking 36→37; 2026-08-08 added a full `/api/admin/backfill-pinnacle-catalog` `37 21 * * *` as a reliable Vercel backstop for the daily catalog backfill, whose sole trigger was a droppy cron-job.org 09:37 tick — it dropped 2026-08-08, taking 35→36; verified 2026-08-05 — `abf47065` added `/api/cron/golazos-discover-buyers` `18 8 * * *`, taking 34→35; earlier the count rose back to 34 as `allow-list-reconcile` + `topshot-listing-cache` migrated GHA→Vercel cron, net of dropping the dead `/api/cron/pinnacle-sync` `0 6 * * *` entry (`e719e5e5`, which 401'd every tick — Vercel cron sends only `CRON_SECRET`, the route accepts only `INGEST_SECRET_TOKEN`). History: 33 on 2026-07-28 — itself down from 34 after commit `36cd2acd` retired the dead `sync-sales-ingest-dune` schedule, which had run 36 times with 0 ok since activation, its `DUNE_SALES_INGEST_QUERY_ID` bake never having taken; the route is KEPT, only the schedule removed, mirroring the `evm-transfers-ingest`/`drain-base-parallel-probe` dispositions. 34 was itself down from 35 after `692da543` retired the drained Population-B `drain-base-parallel-probe` schedule. The two newest remaining are the 07-25 AllDay residue drains — `allday-price-recover` at `/api/admin/recover-v1-budget-exhausted` `*/20 * * * *` + `allday-resolve-unmapped-tail` `40 */3 * * *`; before them `candy-listings-indexer` `35 */3 * * *` from the 07-24 Candy parity build; others `allday-lock-refresh-batch` `23 * * * *`, `candy-offers-indexer` `50 */6 * * *`, and the remaining Dune walker `sync-sales-seller-recovery-dune` `47 * * * *` — still **INERT** pending `DUNE_SALES_SELLER_QUERY_ID=8027085`) (`maxDuration` ≤ 800; pack-grail-MV refresh, rip-metadata backfill, misattribution drain, `/api/cron/warm` business-hours warmer, ownership-sync-dune, …).
- **pg_cron** — **93 active jobs** in `cron.job` (re-verified live 2026-08-16 ~23:57Z; **92 earlier the same day**, **85 on 08-14**, 78 on 08-03, ~54 on 07-28, 53 on 07-16, 34 on 07-06 — the 07-16 IOPS-diet work added several delta-rewrite/catch-up jobs; jobid 201 `rpc-candy-wmc-ghost-purge` added 07-19; jobid 215 `rpc-allday-nem-from-sales-backfill` (`cron_heavy`, `*/30`) added 07-25 as the AllDay free-lane self-heal; **jobid 233 `rpc-pipeline-runs-daily-rollup` (`11 */6 * * *`) added 08-01**; the two newest are the FMV-propagation pair — **jobid 302 `rpc-backfill-wmc-fmv-confidence` (`2-59/5`)** and **jobid 303 `rpc-refresh-wmc-fmv-changed` (`7-57/10`)** — the same two that produced the #1 and #2 disk readers on the instance, so treat any change to their arguments or cadence as an IO-budget change, not a scheduling tweak). ⚠ **302 no longer passes `NULL`** — since 2026-08-18 its command rotates `p_collection_id` across Top Shot → All Day → UFC → Golazos (`minute/5 % 4` on the `2-59/5` schedule), because `LIMIT p_limit` sits INSIDE the `targets` CTE **above the join**, so an unscoped tick only ever examined the first 1,000 rows in `(collection_id, edition_key)` order — **53,035 `disney_pinnacle` rows that the single-key join cannot resolve and that therefore never leave the head**, starving 452,789 Top Shot rows behind them. Measured both ways the same minute: unscoped converts **0**, scoped converts **1,000** (14,056 ms/tick). **Pinnacle is excluded on purpose**; its fix is the triple / `render_id` re-key. ⚠ **The 85 → 92 jump is ONE change, not seven new jobs: the 2026-08-16 trust-precompute split retired jobid 287 and created eight per-leg jobs 324–331 (85 − 1 + 8 = 92)** — so a future pass diffing this count should look for a split/merge before assuming seven pipelines were added. The **92 → 93** step is the ordinary kind, two genuinely new MV refreshers landing the same day: **jobid 332 `rpc-refresh-special-serial-owners-mv` (`43 4,16 * * *`)** and **jobid 333 `rpc-refresh-topshot-buyback-daily` (`51 8 * * *`)**. ⚠ **Do not derive the count from the highest jobid** — jobids never decrease and are not reused, so 333 existing says nothing about how many rows there are; **`count(*)` is the only answer.** ⚠ **`cron.job` has no inactive rows today (93 total = 93 active), so `count(*)` and `count(*) filter (where active)` agree — do NOT read that as proof the two are interchangeable**; a paused job (the documented disposition for `cadence-payer-balance-check`) makes them diverge. In-DB refreshes/backfills: conflated-editions remap, thin-FMV guard, special-serial-owners MV, serial-FMV weekly fits, rookie ownership MVs, rwfd delta/catch-up, …. `check_pgcron_recent_failures()` is the authoritative pg_cron health check (reads `cron.job_run_details`, which `detect_stalled_pipelines()` can't see).

✅ **CLOSED 2026-08-17 — the `Pipeline Success Coverage` sentinel arm ships this; the paragraph below is WHY it exists and its reasoning still holds, but "nothing watches success" is no longer true.** The arm flags any pipeline on `pipeline_cadence_watchlist WHERE is_active` whose `pipeline_runs_daily` rollup over the last 24–48 h shows **runs > 0 AND zero successes AND zero rows written**, honouring `pipeline_alert_suppression`. ⚠ **The `rows_written` term is NOT in the sketch below and is load-bearing:** measured over the 20 days to 2026-08-17, zero-successes ALONE produced **4 false positives, every one a pipeline degrading gracefully by design** (`reconcile-saved-wallet-stats` wrote 7 and 19 rows on the days it fired; `candy-offers-indexer` 12 and 14). Adding it removed **4 of 4** and kept **5 of 5** genuine outages. ⚠ **AND THAT TERM IS ALSO THE ARM'S COVERAGE BOUNDARY, measured 2026-08-17 and previously unwritten: it makes the arm BLIND to "writes rows and never completes".** A watchlist-coverage audit that day found **62 of 149 live pipelines unwatched**, of which **5 had zero successes in 7 days — and FOUR OF THE FIVE were writing rows while failing** (`drain-conflated-subeditions` 1,999 rows on a statement timeout; `topshot-misattrib-drain` 888 on a rekey timeout; `ownership-sync-dune` 114,083 on an `HTTP 402`; `topshot-wmc-fossil-drain` 0, since retired). **Watchlisting all five would surface only `sync-nba-projections`.** ⛔ **This is NOT a reason to drop the term** — it earned its place on measurement, and removing it re-admits the 4 graceful-degradation false positives. It is the honest edge of what the arm claims, and a partial-write failure needs a DIFFERENT detector (e.g. terminal-row absence against the `<x>-heartbeat` denominator), not a weaker threshold on this one. ⚠ **Thresholds are DERIVED: the count never exceeded 2 in those 20 days (0 on 11 of them), so `crit_at` defaults to 3** — one above the observed ceiling, because critical **fails the GHA job** and this repo has already paid for a permanently-red workflow (`edge-fn-drift`). ⚠ **It reads the ROLLUP and states its `refreshed_at` age on every reading** — a 24 h window of `pipeline_runs` is ~3 k rows, over the 1000-row cap, so aggregating that directly would silently truncate and make the arm UNDER-report; the cost is a ≤6 h lag, so **do not use this arm to confirm a recovery**. ⚠ **The filing's stated reason for NOT shipping it was refuted by measurement** — *"warn notifies and the sentinel runs hourly, so this buys hourly noise"* — the sentinel is **already WARN and already notifying hourly** (`Pipeline Silence` + `Trust Health`), so the arm adds a line to a notification already being sent. Fires on exactly one pipeline today: `match-topshot-players` — **independently re-verified live 2026-08-17 15:5xZ against `pipeline_runs_daily`: runs 2, ok 0, rows_written 0, `rpc_failed: upstream request timeout`, and it is the only watchlisted pipeline meeting all three conditions.** Tests: `__tests__/api-sentinel-pipeline-success-coverage.test.ts`. ✅ **AND IT IS NOW VERIFIED IN PRODUCTION, not just in the DB — 2026-08-17 16:50Z, operator-authorized `workflow_dispatch`:** the live sentinel report carries `Pipeline Success Coverage · warn · value 1 · "match-topshot-players 0/2 ok, 0 rows — rpc_failed: upstream request timeout (since 2026-08-16, rollup 279m old, 19 suppressed)"`. ⚠ **That tick also validated the read-the-rollup decision in a way nobody planned: three sibling checks (`Sales Ingest`, `FMV Confidence`, `Sniper Feed`) ALL went `INCONCLUSIVE (db saturated)` in the SAME run while this arm still produced a real answer.** The rollup read survives the saturation that kills direct queries — a second, independent reason never to "improve" this into a live aggregate over `pipeline_runs`. ⚠ **ITS WINDOW MUST STAY WIDER THAN THE SLOWEST WATCHLISTED CADENCE.** Measured 2026-08-17, the longest active `max_silent_minutes` is **1800 (1.3 days)**, so every current entry fits inside 24–48 h with margin; a slower pipeline FLAPS (in scope on its run day, `runs = 0` and absent for the rest of its period). ⚠ **That is an ERGONOMIC weakness, NOT a dishonest one, and my own first draft of this said otherwise** — the healthy detail is scoped to *"pipelines THAT RAN since `<day>`"*, so on the silent days it makes no claim about the absent pipeline. **I had reasoned about the shape instead of reading the string.** If a weekly/monthly pipeline is ever watchlisted, derive the window from `max_silent_minutes` (`max(48h, 2× cadence)`) rather than widening the constant for everyone. ⚠ **There is NO live candidate any more:** `topshot-wmc-fossil-drain` was the only one and it was **UNSCHEDULED on 2026-08-17** once its fossil population measured zero, so it can no longer produce runs at all. **Keep the rule as forward guidance, not as a description of anything currently watched.**
  ⚠ **THE ARM SURFACES `last_error` VERBATIM, AND ITS ONE CURRENT ALERT IS THE STRING THIS FILE MISREAD FOR A DAY — read the `~125 s` correction below before acting on it.** The detail an operator will see is `upstream request timeout`, which is a **Supabase gateway** timeout, **not** Postgres's `canceling statement due to statement timeout`; `match_topshot_players_run` actually runs to **281 s** server-side. So the fix is neither a Postgres budget nor the function's (inert) `proconfig` — **do not reach for either.** The lever remains the one already recorded: the **sports-proxy 403** starves `nba_players`, so this matcher can produce no aliases however fast it runs.

⭐ **2026-08-30 — A SECOND SUCCESS-COVERAGE ARM NOW EXISTS, DB-SIDE, AND THE TWO DISAGREE BY DESIGN. Read both before adding a third.** `public.check_pipelines_running_but_not_succeeding()` (migration `20260830165431`) is appended in the `get_pipeline_alerts()` wrapper alongside `check_edge_fn_http_failures()`. Same predicate as the sentinel arm — **zero successes AND zero rows written** — and the same negative control (`reconcile-saved-wallet-stats`). **The difference is the WINDOW, and it is the whole point:**

  - **Sentinel arm** — a FIXED **24–48 h** window over **`pipeline_runs_daily`**. It reads the rollup deliberately, because `pipeline_runs` exceeds **PostgREST's 1000-row cap** from OUTSIDE the database. Consequence: it lags up to 6 h (**measured 5 h stale on 08-30**), and **a pipeline that succeeded 30 h ago but has failed every run since reads HEALTHY**.
  - **DB-side arm** — each pipeline judged over **its own `max_silent_minutes`**, against **live `pipeline_runs`** from inside the DB, so neither the cap nor the rollup lag applies.

  Measured 2026-08-30 17:1xZ: **both** fire on `ingest`; **only the DB-side arm** fires on `match-topshot-players` (1 ok 30 h ago) and `wallet-username-resolver` (6 ok yesterday, 0 inside its 450-min budget). ⚠ **A pipeline both arms catch emits TWO alerts, and they share `pipeline_alert_suppression` — so one bounded suppression silences BOTH, a wider action than it looks.**

  🚨 **AND THE BLINDNESS IS WIDER THAN THIS FILE SAID: `public.detect_stalled_pipelines()` HAS IT TOO.** The paragraph below indicts "the cadence arm"; in fact **both** silence detectors read `max(started_at)` with **no `ok` filter** — the arm inside `get_pipeline_alerts_core()` *and* the standalone `detect_stalled_pipelines()` that health sweeps and handoffs call directly. **Neither can fire while a second, permanently-failing caller keeps writing rows.** Found via `topshot-active-listings-ingest`: its WAF-blocked GitHub-Actions arm (0/9, `egress_blocked`, 0 Atlas calls) writes a row every ~3 h, which would have held the **900-minute** alarm green even if the residential Task Scheduler arm — **the only one that actually feeds the board** — went dark for days.

  ⚠ **The lesson for the next author, recorded against the session that shipped the DB-side arm:** this file already said all of the above about the sentinel, under a ✅ CLOSED banner, and I built the second arm **without reading it** — I grepped `pg_proc`/`cron.job`/callers for the MECHANISM I had already chosen, which cannot find a sibling detector in another layer or a paragraph in a reference doc. **Grep for the QUESTION, not the objects you plan to touch.**

⚠ **[THE ORIGINAL FINDING, kept for its reasoning] THE PLATFORM HAS CADENCE COVERAGE AND ESSENTIALLY NO SUCCESS COVERAGE — a watchlisted pipeline can fail 100% for days with every arm green (measured 2026-08-16).** `apply-fmv-haircut` and `match-topshot-players` are BOTH on the active `pipeline_cadence_watchlist`, and both failed **every daily run for 3+ days** with nothing firing. That is not a watchlist bug — it is what a cadence arm *is*: it watches **silence**, both crons fired perfectly, and **a failing run still writes a `pipeline_runs` row**, which refreshes `last_run` and keeps the arm green. Same lesson the `Ownership Index Freshness` bullet records — *`rows_written > 0` is the entire difference* — but the scope is wider than one pipeline: **nothing on this platform watches whether a scheduled pipeline SUCCEEDS.** The cheap closer is one arm over `pipeline_runs_daily`: any watchlisted pipeline whose trailing-24 h **`ok_count` is 0 while `runs` > 0**. ⚠ **Do NOT spell it `fail_count > 0`** — that fires constantly on the saturation-class pipelines that are *working* (`refresh_wmc_fmv_changed` runs at a 32.6% failure rate and writes 409,110 rows). **Zero successes, not the presence of failures.** Filed with the design + the threshold judgement left to an operator: [inbox 2026-08-17T0320Z](../../docs/overnight/inbox/2026-08-17T0320Z-pipeline-restoration-sweep-what-is-fixed-what-is-blocked-and-the-monitoring-gap.md).

⚠ **THE INERT-`statement_timeout` POPULATION NOW HAS LIVE CASUALTIES, AND THEY ALL DIE AT ~125 s — treat that number as a signature (2026-08-16).** `apply-fmv-haircut` (125,164 / 125,188 / 125,169 ms on three consecutive days) and `match-topshot-players` (125,716 / 126,089 / 126,112 ms) both declare `statement_timeout=300s` in their RPC's `proconfig` and both were killed by the **global 120 s** plus IO-throttle overshoot. Same signature as `drain-conflated-subeditions`. **A run ending at ~125 s is that trap, not the route's `maxDuration`** (both routes declare 300 s and neither reached it).

⚠ **THE ~125 s ATTRIBUTION ABOVE IS WRONG — IT IS A GATEWAY TIMEOUT, NOT A POSTGRES STATEMENT KILL (measured 2026-08-17), and the two are trivially separable by the ERROR STRING nobody read.** `pipeline_runs.error` for both pipelines says **`upstream request timeout`** — a Supabase **gateway/proxy** error. Postgres's kill says `canceling statement due to statement timeout` (57014), which is what the pg_cron casualties genuinely show. Three independent confirmations: (1) `pg_stat_statements` records `match_topshot_players_run` at **mean 153,795 ms, max 281,567 ms** — Postgres plainly did **not** stop it at 120 s; (2) as established two bullets up, **no Postgres timeout binds a `supabaseAdmin` call at all**, so there is no 120 s ceiling on that path to hit; (3) ⚠ **the stability is itself the tell — 125,164 / 125,169 / 125,188 ms across three days is a FIXED timer to within 24 ms**, whereas a statement killed at a budget "plus IO-throttle overshoot" would scatter. Corroborating: `apply-fmv-haircut` **succeeded at 109,916 ms** on 08-17, i.e. just under the same fixed bound. ⚠ **The coincidence that made this so convincing is real and will recur: the Supabase gateway's request timeout and the Postgres global `statement_timeout` are BOTH ~2 minutes**, so the numbers agree and only the error text disagrees. **Read `pipeline_runs.error` before attributing any ~125 s death, and never treat the duration alone as a signature.** The consequence for the fix is material: raising or lowering a Postgres budget cannot help these two, and the ~281 s of real work means the statement keeps running server-side after the client has already given up — burning a pooled connection on the instance whose saturation is the root cause. The fix is never the clock: `apply-fmv-haircut` was restored by splitting one all-collections statement into one per collection (each leg gets its own 120 s); `match-topshot-players` is filed, not fixed, because its cost is an 827 MB `wallet_moments_cache` aggregation.

⚠ **MINUTE-LEVEL STAGGERING CANNOT FIX THE SATURATION CLASS — the schedule is oversubscribed in DURATION, not in start minutes (measured 2026-08-16, [inbox 2026-08-16T1520Z](../../docs/overnight/inbox/2026-08-16T1520Z-the-13-stagger-is-REFUTED-do-not-run-it.md)).** For every `rpc-backfill-historical-pack-ev` run over 24 h, the number of other cron jobs in flight tracked **its own runtime**, not its start minute: 73 s → 6 overlapping, 216 s → 11, 311 s → 17, **601 s → 26**, **611 s → 29**. A job with a p95 of 531 s spans ~9 minutes and overlaps whatever starts anywhere in that window. ⚠ **This CONVERGES with the trust-precompute split from the other direction** — *"rescheduling is dead as a fix; it only chooses which legs starve."* **Two instruments, one answer: the lever is the WORK (page size, fan-out, budget isolation), never the clock.**

⚠ **AND THE "`:13` COLLISION" ROOT CAUSE THIS FILE CITES IN TWO DATED ENTRIES IS STALE — do not re-derive or act on it.** Live, minute 13 holds **one** hourly job (jobid 71) plus jobid 109 twice a day; **jobid 235 already moved to minute 7**, so the only genuine collision is 2 h/day. ⚠ **A `:13` stagger block was promoted to "ready-to-run, reversible" in an overnight handoff and is HARMFUL as written**: its leg one moves a job that runs *alone* 22 h/day onto minute 40, which already holds jobid 67 (max 618 s) — buying a guaranteed hourly overlap of two ~10-minute jobs — and its leg two stacks onto jobid 4 `rpc-ccm-step2`, which had just recovered from a 44 h stale spell caused by this very class of timeout. **"Reversible" describes the revert path and says nothing about whether the change is CORRECT**; the two get conflated the moment a block is pasted rather than re-derived, and **the cheapest possible check on any reschedule is whether the target slot is occupied — one query.**

⚠ **`pgcron-startup-timeout` IS A SATURATION SYMPTOM, NOT A WORKER-SLOT CAP — and the obvious config fix does NOTHING (measured + REFUTED 2026-08-16).** The seductive reading is `cron.max_running_jobs = 32` against `max_worker_processes = 6`, a 5× oversubscription, and the first evidence fits it: failures arrive in **contiguous time bands**, not at high-start-count minutes (03:52Z had 6 starts / 0 failures; 03:39Z had 3 starts / 3 failures), and during one band exactly **six** multi-minute jobs overlapped. **It is wrong.** Two measurements kill it: (1) the concurrency histogram has **occupied states ABOVE the supposed cap** — concurrency **7, 8 and 9 all occur with ZERO timeouts**, and a cap that is exceeded is not a cap; (2) decisively, **`cron.use_background_workers = off`** (the pg_cron default, verified live), so this instance runs each job as an **ordinary libpq connection to `localhost`** against `max_connections = 90`, never as a background worker — **`max_worker_processes` is irrelevant to this alert**. "Job startup timeout" is a **connection handshake failing to fit under load**, i.e. a second symptom of the documented disk-IO saturation. ⚠ **So do NOT open it as its own investigation and do NOT change `cron.max_running_jobs` or `max_worker_processes`** (the latter is Supabase-managed and needs a restart). It is chronic, not new — daily rate over 10 days 0.50% → 5.01%. The concurrency correlation is real but is **LOAD, not a slot cap** (3.65 concurrent at timeouts vs 2.68 at successes). **The one concrete lever is the same one this section already names:** 44 runs across 17 jobs died at the ~600 s `cron_heavy` budget in 2 days, each holding a connection for ten minutes and rolling back — ~7.3 h of connection time producing nothing, which is precisely what makes connection startup slower for everything else. Falsifier: if lowering `cron.max_running_jobs` moves the rate, this is wrong. Filed: [inbox 2026-08-17T0410Z](../../docs/overnight/inbox/2026-08-17T0410Z-the-pgcron-startup-timeout-is-not-a-worker-slot-cap-it-is-the-saturation.md).

⚠ **`rpc-public-board-liveness-sweep` (jobid 288, `28 */6`) IS THE MONITOR THAT WATCHES THE PUBLIC BOARDS, AND IT IS BOTH FAILING AND FEEDING THE SATURATION IT DETECTS (measured 2026-08-17).** It is not a cheap probe: it runs full `SELECT count(*), count(t.*) FROM <board>` over the expensive public board views, and it dies at a **900 s** budget — **08-16 12:32Z timed out on `candy_scarcity_board`, 08-17 12:28Z on `panini_squeeze_board`**. ⚠ **The failing statement MOVES between runs**, the same "drew the short straw" signature this file records for the prerendered-board builds and the old monolith — so **do not go optimize whichever board the last message named**; it is the sweep's total cost against a saturated instance, not one bad view. ⚠ **AND A `succeeded` STATUS DOES NOT MEAN IT MEASURED ANYTHING: the 06:28Z run "succeeded" in 413.6 s having recorded `probed: 0, budget_exhausted: true`** — it burned nearly seven minutes of connection time and probed zero boards. **Read `public_board_liveness_probe()`'s `probed` and `sweep_age_min`, never the cron status.** Two consecutive cycles producing no usable data is what makes `rpc_thp_leg_board_liveness` publish **999** on both its arms — so **three of the six breached arms on 2026-08-17 trace to this one job**, and two of them wear a value this file long described as unreachable. ⚠ **The sweep is a genuine IO consumer on the 2 GB budget** (79.5 s / 413.6 s / 788.2 s / two 900 s kills across five runs), which puts it in the same category as the insights refresher already documented as *feeding the saturation it exists to survive* — **a liveness monitor whose own cost is a material share of the load it reports on cannot be read as an independent instrument.** The lever is the sweep's WORK (sample the boards, bound each count, or read the MVs' own freshness) — never its budget.

✅ **SHIPPED 2026-08-17 — the cadence cut below is APPLIED: jobid 219 is now `52 */6 * * *`** (jobid preserved, still owned by `cron_heavy` so the 600 s budget survived, `cron.job` still 93/93 so no duplicate was created, and the migration is REGISTERED in `schema_migrations` — `supabase/migrations/20260817185500_audit_20260817_impossible_parallel_selfheal_cadence_cut.sql`). All four safety grounds were **re-derived live rather than trusted**, and the cost figure reproduced sharply: 5.74-day window, 134 calls, mean **47,085 ms**, **161.9 GB read (~28.2 GB/day)** at a **6.4%** hit ratio, against **6 productive hours out of 168 runs** in 7 days. ⚠ **Accepted cost, stated rather than glossed:** an offender now waits up to ~6 h to heal instead of ~1 h (~3 editions/day), and the direction is conservative — while `serial > circulation_count` the `serialMultiplier` tail clamps to 1.0, so an unhealed edition is priced with a SMALLER premium, never an inflated one. **Revert:** `SET LOCAL ROLE cron_heavy; SELECT cron.schedule('rpc-selfheal-impossible-parallel-circ','52 * * * *','SELECT public.raise_impossible_parallel_circ();'); RESET ROLE;`. The original analysis follows. ⚠ **`raise_impossible_parallel_circ` (jobid 219, formerly `52 * * * *`) IS NOT WASTE — IT IS REAL HEALING AT 28× THE CADENCE ITS WORK ARRIVES AT, AND I PREDICTED "RETIRE IT" AND WAS REFUTED (examined 2026-08-17, closing an item this file recorded as unexamined twice).** It raises `editions.circulation_count` to `max(serial_number)` for any Top Shot parallel where a sale's serial exceeds the recorded circulation — **monotonic, raise-only, fully audited** into `impossible_parallel_circ_raises`. A circulation below an observed serial corrupts serial multipliers, the special-serial boards and the `topshot_impossible_parallel_serials` arm, so this is a correctness job. ⚠ **Its SHAPE is identical to the retired flowty drain** (hourly, 6.3% buffer hit, 20.9 M blocks ≈ **~30 GB/day**, mean 46 s, usually returning nothing), and this file's own *"an empty result is the most expensive case"* rule makes "it is proving emptiness" the obvious read. **It is doing real work: 147 raises since 2026-07-20, 20 in the trailing 7 days, last 2026-08-16 20:52Z.** ⚠ **A `sum(rows_written)=0` sweep or a "find inert crons" ranking would have called this waste and destroyed live data-integrity healing** — so it is a **FOURTH meaning for a zero-output run** beside the three already recorded: **correct, valuable, and over-cadenced** (zero output on **162 of 168** weekly runs, real output on 6). **The defect is the cadence, not the existence.** Recommended `52 * * * *` → `52 */6 * * *` (168 → 28 runs/week, ~6× IO cut), safe on three CHECKED grounds: offenders accumulate and the function is idempotent + monotonic, so a later run fixes the same rows; **nothing keys on its freshness** (measured **0** watchlist arms, **0** views reading the audit table, **0** other functions reading or calling it — ⚠ this is exactly the step whose omission produced the live `board_mv_refresh_stale_hours` breach); and its only downstream consumer, leg **324**, already refreshes 6-hourly, so hourly buys nothing the board can see. ⛔ **Do NOT make it incremental on `sales.ingested_at`** (no index — seq-scans the partitions, strictly worse) ⛔ **nor on `sold_at`** (market time; the history backfills land months-old rows, so a `sold_at` window silently skips backfill-introduced offenders — correctness traded for IO). ⛔ Do not raise its declared 120 s `statement_timeout`; proven inert. **Filed, deliberately NOT shipped** (a prod cron change at the end of an archived session, with nobody watching for a regression): [inbox 2026-08-17T1712Z](../../docs/overnight/inbox/2026-08-17T1712Z-the-impossible-parallel-selfheal-is-not-waste-it-is-28x-over-cadenced.md).

⚠ **READING THE SENTINEL DIGEST: "N active" is the `high` SUBSET, not the board (2026-08-16).** The failure_rate arm assigns `high` only at `fail_pct >= 50` and `medium` below it, so a digest reading "🚨 8 active" sat on top of a live board of **18** (6 high / 9 medium / 3 info) from `get_pipeline_alerts()`. **Query the function before concluding you have seen the whole board.** ⚠ And `rows_written` is a null instrument here **in both directions**: `reconcile-saved-wallet-stats` reports `ok=false` while WRITING rows (designed partial sweep, healthy), while `allday-unmapped-resolver-tail` reports `ok=false` while writing none (exhausted backlog, also expected). **Read the error STRING and the target's freshness — never the `ok` flag or the row count alone.** ⚠ **Before writing any `pipeline_alert_suppression` row, check what SURVIVES it**: two of those eight alerts had **no `pipeline_cadence_watchlist` row at all**, so suppressing alone would have left ZERO coverage — `reconcile-saved-wallet-stats` got a cadence row (150 min) added *first*, and only then the bounded suppression.

**Rescheduling a `cron_heavy` job (mechanism proven in production by the 8-way split, 2026-08-16).** `postgres` IS a member of `cron_heavy`; `cron_heavy` **CAN** execute `cron.schedule` but **CANNOT** execute `cron.alter_job` — so the working path is `SET LOCAL ROLE cron_heavy; SELECT cron.schedule('<existing job name>', …);`, which updates in place, **keeps the jobid**, and retains the role's `statement_timeout=600s` because the owner is set to the *current* role. The `SET LOCAL ROLE` is load-bearing: without it the job is re-owned and silently loses the 600 s budget.

`/api/admin/prune-pipeline-runs` (daily) keeps `pipeline_runs` ~9.5K rows. **⚠ `pipeline_runs` retains only ~73h** (`prune_pipeline_runs(3)`, pg_cron jobid 57) — far shorter than the time it typically takes to NOTICE a defect here (measured 08-01: only 1 of 5 findings in the 07-31→08-01 wave was still inside the window; AllDay serial supply took ~18d to spot). **So "no matching record in `pipeline_runs`" is usually a RETENTION ARTIFACT, not a finding** — both Cowork and Claude Code drew that false inference on the same 07-28 wallet investigation. Check **`public.pipeline_runs_daily`** first: an indefinite daily rollup (one row per pipeline per UTC day — runs/ok/fail, rows, duration p95, last_error, plus `extra_key_counts` for payload-shape drift), written by `rollup_pipeline_runs(4)` / pg_cron jobid 233. History starts **2026-07-29** and cannot be backfilled earlier; the 07-29 row is permanently partial. ⚠ **NEVER read `pipeline_runs_daily` for RECENCY** — it is refreshed **six-hourly**, so it fabricates silences up to 6 h long; read `refreshed_at` beside `last_run_at`, or query `pipeline_runs` directly. *(Moved verbatim out of CLAUDE.md 2026-08-21 when that bullet was compressed to make room for the `net._http_response` pointer; nothing was deleted.)*

⚠ **BUT `pipeline_runs_daily` IS A SIX-HOURLY ROLLUP, AND READING `last_run_at` FROM IT FABRICATES SILENCES UP TO 6 h LONG — this directly qualifies the "check the rollup first" sentence above, which is correct for VOLUME and TREND and actively wrong for RECENCY (2026-08-16).** The schedule is **`11 */6 * * *`**, not the hourly `:11` this bullet used to imply, so between refreshes the table is *supposed* to lag — by design, not by failure — and the current day's `runs` is always a partial count as-of-refresh. Measured side by side on `offers-sweep`: the rollup said **last run 12:02Z (253.7 min of apparent silence) / 36 runs**, while live `pipeline_runs` said **16:02Z — 7 minutes ago / 46 runs**, with the rollup's own `refreshed_at` **244.8 min stale**. That nearly became a filed 4-hour stall on a pipeline that was healthy (20-min cadence held all night). **Never read `last_run_at` from the rollup without `refreshed_at` beside it; for "is it running right now", query `pipeline_runs` directly.** The two questions must not share an instrument — same family as the current-day-row trap already recorded for `fmv-recalc` throughput. Notable recurring jobs:

- Sales-indexer chained → AllDay-unmapped-resolver (every 20min, NOT its own cron entry).
- HybridCustody events — every 20min.
- Seed-wallet-refresh — cron-job.org fires every 6h (4 cohorts), but the route's 12h in-route gate (2026-07-18) no-ops half the waves; the GHA backstop passes `&force=1` to bypass it.
- Sync-nba-odds — every 60min during 22:00 UTC → 06:00 UTC.
- ownership-sync-dune (Vercel) — Dune TopShot ownership index; **weekly** re-execution to stay inside the free Dune credit tier.

---


---

## ⭐ CRON WASTE TRIAGE — use the committed query, do NOT re-derive one (2026-08-31)

👉 **[`supabase/analysis/cron-waste-triage.sql`](../../supabase/analysis/cron-waste-triage.sql)** — paste it into
Supabase MCP `execute_sql`. Read-only, mutates nothing.

⚠ **Do not write your own "which cron jobs waste the most time" query.** The obvious one — rank by
`sum(duration) WHERE status = 'failed'` over a fixed 7-day window — is the one known-issues #42 used, and it
went **0-for-4**: on 2026-08-29 it ranked jobid 211 **first by a factor of four** (10,214 s of "reclaimable
waste") for a job fixed the day before that had succeeded in ~2 s on every tick since, and it advertised
~15,345 s of savings across four healthy jobs. ⭐ **The mechanism is general and worth carrying out of pg_cron:
a pooled rate straddling a fix measures the fix's ABSENCE and reads as its FAILURE — so the more actively a
fleet is being repaired, the more confidently a pooled ranking points at the jobs that were repaired.**

⭐ **The fix is NOT a shorter window** (that cannot see a daily job at all — it trades one blind spot for
another). It is reporting the pooled and recent windows **side by side** and classifying the split into
**five** verdicts: `LIVE` (reclaimable now — rank on `wasted_recent_s`, never `wasted_pooled_s`), `RECOVERED`
(pooled waste is historical), **`UNPROVEN`** (too few recent runs to tell recovery from luck — derived from
`p_null` = P(zero recent failures | the rate was unchanged), so a daily job that shows two clean runs is not
called fixed), **`SILENT`** (⛔ zero recent RUNS — not recovered, not anything; a job that stopped running
looks identical to a job that was fixed and wants the opposite response), and `UNSCHEDULED`.

⚠ **RUN BOTH ARMS.** Arm 1 (per-job waste) is **structurally blind to `job startup timeout`**, twice over:
its cost is **missing work, not burned time** (the worker never launched, so the body never ran and
NOTHING reaches `pipeline_runs` — both silence detectors are blind to it), and it is a **fleet property,
not a job property**. Measured 2026-08-31: **260 startup timeouts in 72 h across 50 distinct jobs
(86.7/day)** but only ~6,744 s total, so per job it is ~45 s/day and sorts near the bottom of arm 1 every
time. **Arm 2 groups by UTC HOUR instead**, which is where the signal lives: run counts are FLAT
(507–585/hour) while startup timeouts swing **0 → 65**, so it is concurrency at particular hours, not load
volume — hours **9 / 13 / 18 / 14 / 8** carried **65 / 55 / 54 / 45 / 26** (12.2% of all runs at hour 9),
and hours 0–7 and 20–23 carried ~0. Cause and the ⛔ do-not-restagger-blind rules are in the section below.

**First run, 2026-08-31 05:4xZ** (14 d pooled / 48 h recent): it put **jobid 211 in RECOVERED** with 21,019 s
of pooled waste correctly marked historical, found **jobid 256 `rpc-thin-sale-ask-disclosure-refresh`
UNSCHEDULED** (so #42's "600 s burned daily" no longer applies), and put **jobids 4 and 325 in UNPROVEN**
(`p_null` 0.184 and 0.473) rather than in #42's "all four healthy" — which is the instrument declining to
claim what it cannot support in **both** directions. ⚠ Header caveats in the file cover the traps that are
specific to this data (`status <> 'succeeded'` vs `= 'failed'`, self-cancel artifacts, queue wait in
`start_time`, and that a pg_cron `status` is a dispatch outcome, not the work's).

## ⭐ FLEET HEALTH — a whole-`pipeline_runs` sweep, 24 h to 2026-08-27 02:00Z (a dated sample; re-derive)

**161 distinct pipelines, 15,636 runs, 1,078 of them `ok = false` (6.9%).** The point of this block is not the numbers, which move; it is that
**four of the five worst-looking pipelines are lying about their own health in four DIFFERENT ways**, and the
`ok` column separates none of them.

| pipeline | 24 h | what the failures actually are |
|---|---|---|
| `topshot-pack-pool-backfill` | **1 ok / 273 failed** | 258 × the SYNTHESIZED `0/3 dists converted; 3 returned no editions` (a correct report of an empty queue, deliberately made falsifiable) + **15 × `canceling statement due to statement timeout`** — a real fault hiding inside a 94% signature. Registered as known-issues **#38**. |
| `reconcile-saved-wallet-stats` | 1 ok / 20 failed | Every one is `soft_deadline_reached_partial_sweep_committed` — **work was done and committed**. `ok = false` here means "did not finish the sweep", not "failed". |
| `sync-nba-projections` | **0 ok / 8 failed** | `all_upstreams_failed` on every tick — honest, and matches known-issues **#8**'s measured-dead ESPN finding. The pipeline is fine; the upstream is gone. |
| `topshot-active-listings-ingest` | 5 ok / 4 failed | All four are `egress_blocked` — **zero DB timeouts**, where 29 of 40 were DB timeouts a week ago. The fault MOVED (#30 → #20). |
| `allday-pack-opens-backfill` | 4 ok / 2 failed | Only **6 rows against 144 dispatches** — the interesting number is the one that is ABSENT, not the two failures (`events … status 503`). #29. |

⭐ **The reusable rule: rank by `ok = false` and you get a queue sorted by nothing.** Two of these five are
healthy, one is honestly reporting a dead upstream, one has silently changed fault class, and one is hiding a
second fault inside a first. **Read `error` (and `extra`) before you read the count** — and note that a
pipeline whose steady state is 99.6% red is a permanently-red instrument, which this repo has already learned
trains readers to skim (`series_detail_rollup`, known-issues #25).

ⓘ **Cron fleet at the same instant:** **99 jobs, all `active`**; **18** declare a `statement_timeout` in their
command and **15 of those declare `600s`** — so known-issues #27's "these three are too generous" is a
statement about a house default, not about three outliers.

## `fmv-recalc` — RE-CHARACTERIZED 2026-08-17: wasteful, not broken

⚠ **The long-standing "~66% background kill rate, un-diagnosed" line understated the rate and badly overstated the harm.** Re-measured 2026-08-17 over 24 h, using **`fmv-recalc-heartbeat` as the denominator** (the true invocation counter — `fmv-recalc` only logs on terminal completion, so filtering to that name is a SAMPLE, not a census):

| quantity | value |
|---|---|
| heartbeats (true invocations) | **172** |
| runs that wrote a terminal row | **47** (27.3%) |
| of those, `ok` | **34** |
| **killed at the 300 s `maxDuration` wall** | **125 / 172 = 72.7%** |
| rows written | **17,535** |
| **distinct editions repriced** | **13,835** |

⭐ **RE-MEASURED 2026-08-26 (24 h to 2026-08-27 02:00Z) with the SAME correlation instrument — the shape holds
and the throughput is up:** heartbeats **160**, terminal rows **58** (36.3%), of those `ok` **47**, rows
written **24,959**, **distinct editions repriced 14,665** (was 13,835). Implied kill rate **102 / 160 =
63.8%**, against 72.7% on 08-17. ⛔ **Do NOT report that as an improvement** — two instants, nine days apart,
on an instance whose saturation varies hour to hour; this file's own rule is that a directional claim needs a
distribution. **What IS supportable: the characterisation "wasteful, not broken" is unchanged, and the daily
repriced-edition count still exceeds the traded population, so the waste is still not costing accuracy.**

⚠ **The "treadmill" reading is REFUTED, and it is a trap worth naming because the evidence for it looks conclusive.** The hypothesis — *no `cursor_after` is ever persisted, so every run restarts at offset 0 and reprocesses the same 500 editions* — is supported by the route's own header warning about exactly that, by every run's `extra` carrying `has_more: true` with **no cursor keys at all**, and by every success writing a uniform 496–499 rows. **The outcome measure kills it: 13,835 DISTINCT editions in 24 h, not ~500.** The selection is staleness-ordered and therefore self-advancing; it does not need a cursor. ⛔ **Do not "fix" the cursor — it is not the defect.**

**The real shape is a COST problem:** ~125 invocations/day × 300 s ≈ **10.4 h/day of Lambda compute that writes nothing**, plus its DB load on the instance whose IO saturation is the documented common cause behind the insights board-warm failures, the entity-page pool timeouts and the pgcron startup timeouts. The surviving ~27% is sufficient to cover the catalogue.

### Catalogue-wide FMV freshness (2026-08-17) — and why the stale share is mostly not an accuracy problem

`≤2 days` **14,659** · `2–30 d` 5,641 · `30–90 d` **6,711** · `>90 d` **0** · never priced 188, of **27,199** editions.

⚠ **Of the 6,899 in the 30-day-plus tail, 6,398 are Top Shot editions of which only THREE have any sale at all** — structurally unpriceable by any algorithm, correctly excluded rather than missed. **Do not report the ~25% stale share as a pricing defect.** The genuinely actionable remainder was 501 UFC Strike editions, which turned out to be the collection-blind phantom-guard bug in `drain_fmv_cold_tail` (fixed 2026-08-17).

⚠ **`>90 d = 0` is a live tripwire, not an empty instrument** — it is currently a true zero. If the cold tail ever stops being drained, that bucket becomes non-zero. Re-derive it rather than quoting these counts.

---

## ⚠ `net._http_response` — the instrument for any pg_cron `net.http_get` pipeline, and it needs NO deploy

**Promoted here 2026-08-21 because it had been used in the ledger EIGHTEEN times and appeared in no
reference doc — and on that same day a session (mine) wrote *"the instrument that would settle it does not
exist here"* about a pipeline this table describes completely, after having already queried the table
during the investigation.** That is the exact failure CLAUDE.md predicts for a fact left only in a session
log. It is the reason this section exists.

Every `net.http_get` that pg_cron issues writes a row here, server-side, with **no application code and no
edge-function deploy** — so it is available even when a function is behind a deploy blocker. It carries
`status_code`, `timed_out`, `error_msg`, `content` and `created`. Retention is short (**~6 h measured
2026-08-21**), so sample it while the window is open.

**What it settles that `pipeline_runs` cannot.** A pg_cron pipeline that leaves no terminal row is
ambiguous three ways; this table splits them:

| observation | meaning |
|---|---|
| no `cron.job_run_details` row | never dispatched |
| dispatched, no `net._http_response` row | still in flight, or the row aged out |
| `timed_out = true`, `status_code` NULL | the caller gave up — the function may still be running |
| `status_code` 2xx with a body | the tick answered; read `content` for its own accounting |

⚠ **`cron.job_run_details.status = 'succeeded'` means the `net.http_get` was QUEUED, nothing more.** It is
a dispatch record, not an outcome, and `return_message` is `"1 row"` on every success.

### ⚠ Two attribution traps, both measured 2026-08-21

1. **The table is shared by every http cron job, so a naive filter mixes pipelines.** Filtering
   `content LIKE '%backfill%'` matched 162 rows belonging to other functions; a minute-of-hour filter
   matches every job scheduled on that minute. **Discriminate on a field only the target emits**
   (a distinctive key in its JSON body), or on a timeout value only one job uses.
2. **There is no join key from `cron.job_run_details` to `net._http_response`.** `return_message` does not
   carry the request id. Correlate by time and by a discriminator as above, and say which you used.

⚠ **Query `cron.job` with the gate key MASKED.** Reading `cron.job.command` to find a caller prints a live
`?key=` into the transcript — this has now happened twice. Use
`regexp_replace(command, 'key=[^&'']+', 'key=***')`.

### 🚨 Gate-key rotation — the order is load-bearing, and the filing that says it is CLOSED is wrong

**Rotating a cron's `?key=` before the edge function's secret exists fails that pipeline's ticks
CLOSED.** Six of the remaining gate-keyed crons point at secrets that are **not set yet**, so the only
safe sequence is, in order:

1. **set the secret** on the function (`GATE_KEY` / `*_GATE_KEY`),
2. **deploy the function from repo source** so it reads the new secret (the `_OLD` dual-accept pattern
   in the `rpc-edge-fn-deploy` skill makes this zero-downtime),
3. **only then rotate the `cron.job` command.**

⚠ **`inbox/2026-08-16T1455Z-gate-key-rotation-item-is-CLOSED-all-14-verified.md` says the item is closed
and all 14 are verified. IT IS NOT CLOSED.** That sweep verified *shapes* — every job has a `?key=`, none
is a placeholder, all match `^rpc_pls_` — which is a real and useful check but is **not** a check that the
function on the other end accepts the key it is being sent. A session that reads that filing and proceeds
to rotate will take those pipelines dark, and a gate-key rejection **writes no `pipeline_runs` row**, so
the outage looks exactly like "never scheduled" (the 86-hour 08-11 outage's own signature). Rotation
progress as last reported: **4 of 14** (jobid 26 `rpc-allday-resolve-rip-dist-api` most recently) —
⚠ taken from an operator close report and NOT re-verified, because confirming a rotation means reading a
key, which this file forbids; use the md5-fingerprint method in `tooling-gotchas.md` if you must compare.

**Related, and now clean: every `net.http_*` cron caller passes an explicit `timeout_milliseconds`.**
Jobs **83** / **84** (`rpc-pinnacle-mints-forward` / `-backfill`) were given `timeout_milliseconds := 240000`
on 2026-08-22 (DB state, **in no commit** — see the ledger entry of that date, which is its only record),
taking the fleet from 12 of 14 to **14 of 14** (re-verified live 2026-08-22 14:30Z). ⚠ **That fixed an
INSTRUMENT, not a pipeline** — a 20 s job under a 5 s caller timeout has its reply abandoned *by
arithmetic*, so `net._http_response` logged `timed_out` on one of the healthiest pipelines in the fleet.
Do not credit it with a throughput win, and do not read the residual `timed_out` share as a before/after
measurement without bucketing by the requested timeout.

## 🚨 `job startup timeout` — the cause is a CONFIG MISMATCH, and the ledger named it a "global condition" twice before this (measured 2026-08-22)

```
max_worker_processes   = 6
cron.max_running_jobs  = 32
```

pg_cron runs **each job as a background worker**, drawn from `max_worker_processes` — a pool of **6**,
shared with parallel-query workers and the logical-replication launcher. `cron.max_running_jobs = 32`
tells pg_cron it may run 32 at once. **When more jobs overlap than there are worker slots, pg_cron
cannot launch one and records `job startup timeout` — the function body never runs, so NOTHING reaches
`pipeline_runs` and both `detect_stalled_pipelines()` and the cron-silent checks are structurally blind
to it.**

Measured over 24 h on 2026-08-22: **169 startup timeouts across 28 distinct jobs** (a 30-minute alert
slice showed only 18/12), **peak concurrency 17**, **252 minutes/day above 5 concurrent**.

⚠ **Precision caveat on that concurrency figure** — it expands each run over its start→end minutes and
so also counts runs that themselves died of startup timeout. It overstates. The direction is not in
doubt (17 against a pool of 6); do not quote 17 as exact.

⛔ **The lever is NOT raising `max_worker_processes`** — it is compute-tier-linked, needs a restart, and
CLAUDE.md forbids buying the way out. **The lever is reducing overlap.**

### 🔁 Re-derived 2026-09-02 — the rate is FLAT PER JOB, which is what a shared-pool model predicts

7-day window, `cron.job_run_details`: **384 `job startup timeout` = 76.6% of all failures**, inside
R29's filed 67–80% band and unchanged. What is new is the SHAPE. Expressed as a share of *each job's
own* runs:

| job | schedule | owner | startup timeouts (7 d) | % of ITS runs |
|---|---|---|---:|---:|
| `rpc-pinnacle-mints-backfill` | `*/2 * * * *` | postgres | 71 | **1.4 %** |
| `rpc-topshot-pack-sales-backfill` | `1-58/3` | postgres | 36 | **1.1 %** |
| `rpc-allday-pack-sales-backfill` | `*/3` | postgres | 36 | **1.1 %** |
| `rpc-allday-dist-opened-backfill` | `2-58/4` | postgres | 35 | **1.4 %** |
| `rpc-backfill-wmc-fmv-confidence` | `2-59/5` | postgres | 28 | **1.4 %** |
| `rpc-backfill-pack-pool` | 12×/h | postgres | 18 | **1.7 %** |
| `rpc-roll-pack-ask-hourly-low` | `7,22,37,52` | cron_heavy | 13 | **1.9 %** |
| `rpc-refresh-wmc-fmv-changed` | `7-57/10` | cron_heavy | 12 | **1.2 %** |

⭐ **Every job sits at ~1.1–1.9% regardless of schedule, owner, or what it does.** The absolute counts
rank by RUN COUNT, not by any property of the job — `rpc-pinnacle-mints-backfill` leads because it
fires every 2 minutes, not because it is special.

👉 **Two consequences.** (1) This is corroboration of the worker-pool mechanism above from an
independent angle: a shared pool of 6 gives every arriving job the same chance of finding it full, and
a flat per-job failure rate is exactly that. (2) **There is therefore no single job to fix** — the
absolute leaders are the frequent ones, so cutting overlap helps everything proportionally and picking
off "the worst job" would move ~1.4% of one job's ticks. ⚠ **Do not read the ranking as a culprit
list**; rank by `count / that job's own runs`, and every row comes out the same.

⚠ **And the invisible-loss figure follows from the rate, not from a count:** ~55 ticks a day launch
and never run, spread across the fleet, writing nothing to `pipeline_runs` — so a per-pipeline arm can
only ever see it as a missing row, never as a failure.

### ✅ RESOLVED — the class stopped dead at **2026-08-30 18:26:00Z** and the table above is a POOLED reading straddling that (measured 2026-09-02 ~12:5xZ)

🚨 **Read this before acting on anything in the two blocks above.** The subsection immediately
preceding was re-derived earlier the same day over a **7-day window**, concluded *"384 startup
timeouts = 76.6% of all failures … unchanged"*, and is wrong about the present for the reason this
file itself documents: **a rate pooled across a change point measures the change's ABSENCE.** All 384
are on one side of it. The last `job startup timeout` on this database is **2026-08-30 18:26:00Z**.

Matched windows of **66.6 hours** either side of that instant, same instrument, same query:

| window | runs | `job startup timeout` | distinct jobs hit | all failures |
|---|---:|---:|---:|---:|
| before | 11,969 | **270** | **52** | — |
| after | 11,153 | **0** | **0** | **5** |

**270 → 0 across 52 jobs, at 93% of the run volume.** The prior per-job rate was ~1.1–1.9%, so ~110–210
were expected in the "after" window. Zero arrived.

⭐ **THE MECHANISM IS THE ONE THIS FILE PREDICTED, and it was reached the way the file said to reach
it — "the lever is reducing overlap" — except overlap fell because the WORK got cheaper, not because
anything was re-staggered.** Same 66.6 h windows, successful runs only (so timeout durations cannot
flatter it):

| window | ok runs | total ok run-seconds | mean | p95 | max |
|---|---:|---:|---:|---:|---:|
| before | 11,622 | **201,812 s** | 17.36 s | 105.4 s | 768 s |
| after | 11,144 | **25,682 s** | **2.30 s** | **9.4 s** | 551 s |

**7.9× less database time on successful ticks alone**, at 96% of the run count — and mean concurrency
(total run-seconds ÷ wall-seconds) fell **1.02 → 0.11**, which is why a 6-worker pool stopped being
contended. Per job, over the same windows:

| job | runs before → after | mean seconds before → after |
|---|---|---|
| `rpc-refresh-wmc-fmv-changed` (303) | 400 → 398 | **210 s → 15 s** |
| `rpc-atlas-pack-ev` (217) | 66 → 67 | **195 s → 2 s** |
| `rpc-backfill-historical-pack-ev` (71) | 66 → 67 | **178 s → 1 s** |

This is the fleet-scale confirmation of the 2026-08-30/31 top-consumer drain, which had been verified
per-query but never against the fleet.

⭐ **THE OUTCOME CONTROL — the work did not shrink, it completed more often.** `refresh_atlas_pack_ev`
(jobid 217) writes its row only if it reaches the end, so its OUTPUT settles "faster because cheaper"
against "faster because there is less to do". Read from **`pipeline_runs_daily`**, which is indefinite:

| day | completed runs (of 24 ticks) | `rows_written` | per completed run |
|---|---:|---:|---:|
| 08-21 → 08-30 | **17 – 23** | 969 – 1,140 | **57.0** |
| 08-31, 09-01 | **24, 24** | 1,368 | **57.0** |

**Identical output per completed run on both sides — 57.0 rows — so the job is doing the same work.**
What changed is that it now finishes every tick instead of ~83% of them.

⚠ **One latent hole found while checking this, and MEASURED NOT TO BE FIRING.**
`refresh_atlas_pack_ev` wraps its whole body in `EXCEPTION WHEN OTHERS THEN RETURN
jsonb_build_object('ok', false, …)` and does **not** log in the handler — so a *catchable* error would
return normally, pg_cron would record **`succeeded`**, and `pipeline_runs` would get no row: invisible
in both instruments at once. **It has never fired.** The identity
`cron ticks − cron failures − completed runs = 0` holds on **every one of the last 12 full days**
(e.g. 08-21: 24 − 7 − 17; 09-01: 24 − 0 − 24), so every non-completing tick was a pg_cron-recorded
timeout, never a swallow. Filed as latent, deliberately not "fixed" on a hot path where the path is
measured dead. ⭐ The identity itself is the reusable part: it separates *killed* from *swallowed*
for any SQL cron job that logs its own completion, and it needs `pipeline_runs_daily` rather than
`pipeline_runs` to reach back more than ~73 h.

🚨 **AND A TRAP I WALKED INTO WRITING THIS, recorded because it produced a confident wrong number.**
My first version of this control read `pipeline_runs` directly and reported **3 completed runs before
vs 66 after**, a 22× claim. That is a **RETENTION ARTIFACT**: `pipeline_runs` keeps ~73 h, and the
"before" window sits 66.6–133 h back, i.e. mostly outside it. The rows were pruned, not missing. This
file already says a missing `pipeline_runs` record is usually retention — **and the 66.6 h matched
window that is correct for `cron.job_run_details` (55-day retention) is exactly the wrong window for
`pipeline_runs`.** Two instruments, two retentions; a window chosen for one silently lies in the
other. `pipeline_runs_daily` is the instrument for anything older than ~2 days, at the cost of a ≤6 h
lag.

⚠ **Controls run before believing it, because "everything got 8× faster" is exactly the shape of a
broken instrument.** (1) The instrument still records: 11,149 runs with `end_time`, and it captured a
statement timeout (jobid 87) and a permission denial (jobid 434) on 09-02. (2) The job mix is
unchanged — **118 distinct jobs before, 117 after** — so this is not jobs being retired. (3) Postgres
has **not restarted in 81 days** and `max_worker_processes` is still **6**, `cron.max_running_jobs`
still **32**, so no config changed under it. (4) ⚠ The rival explanation — that the Top Shot 530
outage simply removed work — is REFUTED as the cause: Top Shot sales ingest continued across the
boundary (**4,428 → 3,015 rows**, 1,929 → 1,673 distinct editions, a −32% market/weekend dip), which
cannot produce a 7.9× fleet-wide cut or a 97× and 178× per-job one.

⭐⭐ **INDEPENDENT CORROBORATION from a different instrument and a different set of pipelines.** The
`wallet-backfill*` family are **HTTP routes, not pg_cron jobs**, and they log to `pipeline_runs`
rather than `cron.job_run_details` — so nothing about the measurement above can propagate into them.
Their failures collapsed on the same boundary, and their errors name the same cause (`Timed out
acquiring connection from the pool`, `canceling statement due to lock timeout`, `rpc upsert_wmc_batch
timed out` — all DB contention), read from `pipeline_runs_daily`:

| pipeline | 08-23 | 08-30 | 08-31 | 09-01 |
|---|---|---|---|---|
| `wallet-backfill-pinnacle` | **225 / 1,125** | 22 / 842 | **0 / 375** | **0 / 571** |
| `wallet-backfill-allday` | **334 / 1,151** | 40 / 876 | 4 / 375 | 6 / 571 |
| `wallet-backfill` | 43 / 299 | 18 / 616 | 8 / 375 | 10 / 571 |
| `wallet-backfill-ufc` | 25 / 494 | 6 / 709 | **0 / 375** | **0 / 571** |

⚠ **Those failures were LOSING ROWS, not just failing** — their `last_error` carries
`wmc_upsert_chunk_failures=N rows_lost=200` / `rows_lost=800` on most of the pre-boundary days, and
none after. So the drain bought data completeness in `wallet_moments_cache`, not only time.

🚨 **AND THE GENERAL RULE, because one session walked into this THREE TIMES in an afternoon:**
**every multi-day window over this database right now straddles 2026-08-30 18:26Z.** A 14-day pooled
`sum(duration) WHERE failed` ranking pointed confidently at jobids 217/71/303, all of whose waste is
pre-boundary. A 5-day aggregate made `reconcile-saved-wallet-stats` look 44% failing when its recent
rate is ~4% (7/11 on 08-30 → 1/24 on 09-01). A `pg_stat_statements` top-consumer list put
`refresh_wmc_fmv_changed` at 666,112 s and mean 240 s, from a window that is ~85% old regime.
👉 **Until roughly 2026-09-13, split every window on that instant or use a `recent` arm** — which is
exactly what `supabase/analysis/cron-waste-triage.sql` exists to do, and it classified all three of
those correctly while the hand-rolled queries did not. **The committed instrument was right and was
overridden; that is the failure to avoid, not the arithmetic.**

⛔ **Consequences for other filed items, which are now measuring history:** #42's per-job waste figures
for jobids 217 and 73, any pooled `pg_stat_statements` ranking (its stats were last reset 2026-08-12,
so ~85% of that window is the old regime), and the "~55 ticks a day launch and never run" figure
directly above — that rate is now **0/day**. The startup-timeout **detector** should be kept: the
class is resolved, not impossible, and it returns the moment total IO climbs back.

### 🚨 …but the 01:00–19:00Z BAND is NOT a scheduling problem, and conflating the two is the trap

⚠ **Measured the same day: the pg_cron RUN COUNT is FLAT across all 24 hours — 480–552 per hour — while
busy-seconds swing 10×** (3,683 at hour 23 → 39,098 at hour 12). **Same number of jobs, up to ten times
the wall time.** That is what the documented disk-IO **burst-credit** model predicts as credits deplete
through the day and regenerate overnight.

**So staggering buys exactly two things, and the band is not one of them:** it lets an *individual* job
finish (move it into 20:00–00:00Z), and it relieves the **startup-timeout class**, which genuinely is
concurrency-driven. **The band's lever remains cutting TOTAL daily IO.** Busy-seconds per UTC hour,
3-day sample, for choosing a slot:

| hour | busy_s | startup timeouts |
|---|---:|---:|
| 8 | 21,666 | 3 |
| 12 | 39,098 | 66 |
| 20 | 6,736 | 0 |
| 21 | 7,132 | 3 |
| 22 | **5,045** | **0** |
| 23 | **3,683** | **0** |

## ⚠ VERIFYING a re-stagger — the obvious check passes ~33% of the time on its own, and the baseline must be REGIME-AWARE (2026-08-26)

After moving the three `job startup timeout` jobs off the pileup (`2f2736c5`), the natural check is
`check_pgcron_recent_failures()` "going quiet". **It is not a test of the fix.** Three separate reasons,
each measured:

1. 🚨 **The function reports LATEST-RUN status, not failures-in-window.** It ends `where l.status = 'failed'`,
   so a job is listed only if its *most recent* run failed. **Job 331 was already absent from the report
   before any tick ran under the new schedule** — its 8 startup timeouts sat in the window unreported
   because the newest run happened to succeed. `fails_in_window` is a column on rows that already cleared
   that gate, so it never rescues you.
2. ⚠ **A pooled failure rate across a CHANGEPOINT describes neither regime.** Per day, jobs 198 and 249 each
   ran **0 failures / 15** through 2026-08-19 and **4 / 6** from **08-20** — the pooled 10.5% / 17.4% is a
   blend of a clean era and a broken one. Using it put `P(check passes | fix did nothing)` at **74%**; the
   regime-aware answer is **33%**. ⭐ **"Use a distribution, not a snapshot" is necessary and NOT
   sufficient — a pooled rate is a third wrong answer, and the most convincing one, because its n is large.**
3. ⚠ **Correlated arms must not be multiplied.** 198 and 249 fail on **exactly the same days** — they shared
   `40 9 * * *` and were colliding with each other. They are **one arm**; multiplying their probabilities
   reports 11% where the honest figure is 33%.

⭐ **Read the check ASYMMETRICALLY: silence is weak evidence, but one `job startup timeout` falsifies the
re-stagger outright.** Worth running daily for that reason alone.

### The gate query — counts ticks on the NEW minute, and carries its own positive control

A re-staggered job is self-identifying: a run at the old minute predates the change, so no cutoff constant
is needed (and none can go stale).

```sql
WITH target(jobid, new_min, old_min, ticks_needed) AS (
  VALUES (198, 54, 40, 3), (249, 56, 40, 3), (331, 55, 9, 11)   -- ticks_needed: regime-aware, p<0.05
),
runs AS (
  SELECT d.jobid, extract(minute FROM d.start_time)::int AS min,
         (d.status = 'failed' AND d.return_message ILIKE '%startup timeout%') AS st
  FROM cron.job_run_details d
  WHERE d.jobid IN (198,249,331) AND d.status IN ('failed','succeeded')
)
SELECT j.jobname, t.jobid, j.schedule, t.ticks_needed,
       count(*) FILTER (WHERE r.min = t.new_min)                  AS new_ticks,
       count(*) FILTER (WHERE r.min = t.new_min AND r.st)         AS new_startup_timeouts,
       count(*) FILTER (WHERE r.min = t.old_min)                  AS old_ticks_control,
       count(*) FILTER (WHERE r.min = t.old_min AND r.st)         AS old_st_control,
       CASE
         WHEN count(*) FILTER (WHERE r.min = t.new_min AND r.st) > 0 THEN 'FALSIFIED'
         WHEN count(*) FILTER (WHERE r.min = t.new_min) >= t.ticks_needed THEN 'CLEARED p<0.05'
         ELSE 'PENDING ' || count(*) FILTER (WHERE r.min = t.new_min) || '/' || t.ticks_needed
       END AS verdict
FROM target t
JOIN cron.job j ON j.jobid = t.jobid
LEFT JOIN runs r ON r.jobid = t.jobid
GROUP BY j.jobname, t.jobid, j.schedule, t.ticks_needed, t.new_min, t.old_min
ORDER BY t.jobid;
```

⛔ **`old_st_control` is load-bearing — READ IT EVERY TIME.** The new-minute columns are expected to read 0
for days, and a zero from a broken query looks identical. The old-minute columns must recover the known
**38/4 · 23/4 · 39/8**; if the control ever reads **0 ticks**, `cron.job_run_details` has aged the old era
out and **the instrument is blind, not clean**. ⚠ That decay is guaranteed eventually — retention held
~48 days on 2026-08-26 (oldest row 07-09, 171,128 rows), so the control expires before a slow gate does.

⚠ **Baseline at first measurement (2026-08-26 05:18Z): `PENDING 0/N` on all three** — every retained run
still fired on the OLD minute, and 331 did not also fire at 03:55Z, bracketing the change to after that.
`cron.job` carried the new schedule with owner preserved and `active=true`, so **the config was right and
only the evidence was missing.** First observations: **09:54 / 09:55 / 09:56Z**.

## ⛔ You probably CANNOT reschedule the job you need to — 42 of 93 are owned by `cron_heavy`

Measured 2026-08-22, and it blocks a whole class of fixes from any session:

| role | owns a `cron_heavy` job? | may EXECUTE `cron.alter_job`? |
|---|---|---|
| `postgres` (what Supabase MCP runs as) | **no** | yes |
| `cron_heavy` (owner of 42 jobs; `postgres` is a member) | yes | **no** — `permission denied for function alter_job` |

`has_table_privilege('postgres','cron.job','UPDATE')` is **false**, so the direct-catalog fallback is
closed too. **Job ownership splits 51 `postgres` / 42 `cron_heavy`, and no session-reachable role can
reschedule any of the 42.**

⚠ **The ledger implies otherwise** — its 2026-08-22 entry records a successful `cron.alter_job` on
jobids 83/84, which happen to be `postgres`-owned. **Check `cron.job.username` before planning a
schedule change.** Routing around it means either granting `cron_heavy` EXECUTE (a privilege change on
the role that runs the heavy fleet) or reassigning ownership — **both are Trevor's call, neither is a
chore.** The operator path that works today is the Supabase SQL editor.

## ⚠ A cursored walker MUST write its `pipeline_runs` row BEFORE it writes its cursor

**Measured 2026-08-21, re-derived and sharpened 2026-08-22.** `app/api/pinnacle/ingest-events`
is the repo's one cursored walker that writes **no `pipeline_runs` row at all**. That makes it
invisible to `detect_stalled_pipelines`, to the cadence watchlist and to every health board
**by construction** — so it can run, fail, and advance its cursor with nobody able to see any
of it. Its zero in a liveness sweep therefore proves nothing on its own; the only honest read
is the OUTCOME store, and `backfill_state.id = 'pinnacle_flow_events'` does not exist (control:
the table is live, 10 other ids, newest `last_run_at` the same day).

**The rule: any new walker writes a `pipeline_runs` row before it writes a cursor.** A walker
whose telemetry is added afterwards has already had a window in which loss was unobservable.
This is the walker-shaped sibling of the `after()` heartbeat rule in CLAUDE.md — same defect,
different surface: a run that ends without a terminal row is indistinguishable from a run that
never started.

⚠ **A DORMANT WALKER IS NOT AUTOMATICALLY A GAP — CHECK FOR A LIVE DUPLICATE FIRST, AND CHECK
IT BY DESTINATION, NOT BY NAME.** Two of the four never-run walkers turned out to be superseded
alternates of live pipelines (`topshot-listings-indexer`; and `app/api/pinnacle/ingest-events`,
which scans the **same** `NFTStorefrontV2.ListingCompleted` event and writes the **same**
`pinnacle_sales` table as the live `pinnacle-sales-indexer`, from an independent cursor). **So
wiring it would not have closed a gap — it would have put two uncoordinated writers on one
table.** ⚠ And the name is no guide: the live `pinnacle-events-ingest` route sits one hyphen
away from the dormant `pinnacle/ingest-events` and does something else entirely (LISTINGS into
`pinnacle_listing_events`). Compare **event type + destination table + cursor store**; reading
the two route headers is what separated them. Full re-derivation:
[inbox/2026-08-22T1500Z-one-of-the-four-never-run-walkers-duplicates-a-live-pipeline.md](../overnight/inbox/2026-08-22T1500Z-one-of-the-four-never-run-walkers-duplicates-a-live-pipeline.md).


## Reading a pipeline's health signals — four shapes learned 2026-08-17

These are generalisations of specific incidents from one session. Each names the instance so it can be
re-checked, and each is a way a pipeline's *own reporting* misleads. **All four were found by measuring the
OUTCOME rather than trusting the pipeline's status.**

### 0. `drain-fmv-cold-tail` is where the "a `try/catch` cannot catch a `maxDuration` kill" rule was measured

**21 silent kills over 2 months** (2026-08-18). The route returns its 202 from `after()`, so a kill takes the
terminal `pipeline_runs` insert with it *after* the caller has already been told the tick succeeded — and no
`try/catch` or `finally` in the handler runs. Read kills by CORRELATION (an invocation heartbeat with no
terminal row), never from a `finally`. *(The `drain-fmv-cold-tail` attribution was moved here verbatim from
CLAUDE.md's `after()` bullet on 2026-08-20; the rule itself still lives there.)* Fixed 2026-08-18 (`714f5d65`):
the tick leaves a heartbeat when killed and stops starting work it cannot finish.

### 0b. ⚠ Reading that correlation: a KILL RATE WITHOUT A RECENCY DISCRIMINATOR IS NOT A HEALTH READING

**Measured the hard way 2026-08-28, by getting it wrong in a filing.** A repo-wide sweep of the
heartbeat correlation produced a table whose only evidence columns were `killed` and `%`, and
`candy-listings-indexer` at **14/25 = 56%** was written up as *"still killed on 56% of ticks after the
08-26 fix — its own investigation."*

⛔ **Wrong. The kills were a contiguous block that had ENDED.** Split at the deploy that landed
2026-08-27 03:48Z (`6455fb9f9`, batching ~1,600 sequential per-page mint lookups into ~32):

| era | ticks | killed | % | avg duration |
|---|---:|---:|---:|---:|
| PRE-fix | 16 | 14 | **87.5%** | **322 s** (of a 300 s wall) |
| POST-fix | 9 | **0** | **0%** | **28.5 s** |

11× faster, zero kills, holding at the 18:35Z peak hour. The fix had worked; the pooled rate was
measuring its ABSENCE and reading as its FAILURE.

⭐ **THE RULE: a pooled kill rate cannot tell "broken now" from "was broken, fixed, and the rate still
carries the corpse."** Both records produce 56% — only the ORDER separates them. ⚠ **And knowing the
boundary is not the same as splitting on it: the fix date was in the filing's own sentence.** Adding
one column pair (`last_kill` vs `last_ok`) **flipped two of the six flagged pipelines**
(`candy-listings-indexer`, `pinnacle-sync`); the four that stood were the four corroborated by a second
instrument before anyone acted on them.

✅ **So it lives in code now, not in a query anyone retypes.** `lib/pipeline/kill-rate.ts`
(`classifyKillRecord`, `correlateRuns`) and `scripts/analysis/killed-after-routes.mjs`
(`npm run pipelines:kills`). ⭐ **It does not accept a rate** — it requires the tick sequence and derives
recency from it, so it cannot be called with the two columns that misled. Recovery is a **test, not a
threshold** (`p = (1 − killRate) ^ cleanTicks`), because 9 clean ticks is decisive after an 87% failure
rate and meaningless after 20%; ⚠ pooling is the **conservative** direction — it deflates the null rate,
raising `p` — so the test can under-call a recovery but cannot manufacture one. ⚠ `recovered` means the
kills stopped, **never that anyone knows why**: attributing a cause is a human naming a deploy.

⚠ **The instrument's own limits, since it is one more thing that can lie.** `pipeline_runs` retains
~73 h, so a pipeline absent from the report has no heartbeat in the window — un-heartbeated, idle and
never-firing are indistinguishable, and **a short report is not a clean bill of health.** Exit codes are
three-state on purpose (**0** nothing failing · **1** failing now · **2** could not measure): collapsing
1 and 2 would let a read failure render as a finding, in the instrument built to detect that. And
`intermittent`/`recovered` deliberately do **not** exit non-zero — a check that goes red on history
stays red forever and stops being read.

### 0c. ⛔ `pipeline_runs.duration_ms` IS NOT EXECUTION TIME — do not rank kill risk on it

`log_pipeline_run` has **no `p_finished_at`**, so `finished_at` defaults to the INSERT and the duration
absorbs retry and queueing on the terminal write. The tell is unmissable once you look for it, measured
2026-08-28: **`topshot-active-listings-ingest` records a p90 of 959,294 ms against a `maxDuration` of
60 s.** Three other pipelines record durations above their route's wall (`run-insider-detectors`
322,813 ms, `offers-sweep` 339,605 ms, `wmc-fmv-populate` 352,922 ms, all against 300,000 ms).

⚠ **So "p90 as a fraction of the wall" — the obvious way to rank which `after()` route most needs a
heartbeat — ranks partly by WRITE CONTENTION.** The E5 batch on 2026-08-28 was chosen by
`pipeline_cadence_watchlist WHERE is_active` instead: the routes where a kill is not merely unlogged
but ACTIVELY MISREAD, because `detect_stalled_pipelines()` alerts on a missing terminal row and a
killed tick and a cron that never fired raise the identical alert while needing opposite responses.

⭐ This is a second argument for the heartbeat marker generally: its timestamps are pinned by
`lib/pipeline/heartbeat.ts`, so they mean what they say.

⭐ **AND THE SIZE OF THE LIE IS MEASURABLE IN ONE QUERY, because many routes already record their own
honest timing as `extra.elapsed_ms`. Diff the two** (2026-08-29):

```sql
select pipeline, count(*) as runs,
       round(avg(duration_ms))                               as avg_recorded,
       round(avg((extra->>'elapsed_ms')::int))               as avg_true,
       round(avg(duration_ms - (extra->>'elapsed_ms')::int)) as avg_inflation,
       max(duration_ms - (extra->>'elapsed_ms')::int)        as max_inflation
from pipeline_runs
where started_at >= now() - interval '24 hours'
  and extra ? 'elapsed_ms' and duration_ms is not null
  and (extra->>'elapsed_ms') ~ '^[0-9]+$'   -- extra is free-form; one non-numeric aborts the aggregate
group by 1 having avg(duration_ms - (extra->>'elapsed_ms')::int) > 500 order by avg_inflation desc;
```

**It found two DIFFERENT classes, and the obvious ranking picks the wrong winner:**

- **Foreign WORK billed to the pipeline** — `allday-sales-indexer` recorded **50,114 ms against a true
  6,155 ms (87.7%)**, `golazos-sales-indexer` 7,168 vs 3,248 (54.7%): both awaited
  `promote_unmapped_sales` (up to 297 s) *before* their own log write. Fixed 2026-08-29 by reordering,
  guarded by `__tests__/indexers-log-before-promote-ratchet.test.ts`.
- **Terminal-write LATENCY** — the `wallet-backfill*` family at 6.8–13.1% with `max_inflation` 57–61 s.
  That is the class this section already describes, and it is **not a defect to fix**: it is real time
  the invocation spent, and removing it needs the `p_finished_at` this RPC does not have.

⛔ **`ufc-stub-thumbnail-resolver` reads 53.6% foreign and is NOT the first class** — its `elapsed_ms`
is computed inline at the call, so the gap is pure round trip; it only looks like half the duration
because the job itself is 978 ms. ⭐ **Rank on ABSOLUTE inflation, never the percentage: a high
percentage on a short pipeline is contention.** ⚠ And the blind spot is exact — **`ufc-sales-indexer`
does not appear at all because it records no `elapsed_ms`**, despite having the identical structure.
Full table + method: [inbox 2026-08-29T1353Z](../overnight/inbox/2026-08-29T1353Z-duration_ms-vs-elapsed_ms-is-a-fleet-wide-contamination-detector-nobody-was-running.md).

### 1. A per-collection ZERO inside an otherwise-succeeding run is the shape a collection-blind filter makes

`drain-fmv-cold-tail` reported `"collection_slug": "ufc_strike", "processed": 0` on every run **for months**,
beside non-zero counts for the other three collections, inside an `ok: true` run with `rows_written > 0`.
Nothing alerted, because the run genuinely succeeded. The cause was a Top-Shot phantom guard
(`NOT (external_id LIKE '%-%' AND set_id_onchain IS NULL)`) applied with **no collection scope**, which
matched **518/518** UFC rows by construction. ⚠ **"Nothing to do" and "structurally excluded" produce the
identical number.** When one member of a per-entity breakdown is persistently zero while its siblings are
not, suspect the FILTER before the data.

### 2. An identical `rows_written` across a SUCCESS and a FAILURE is the signature of a stale cache

`ownership-sync-dune` wrote **exactly 114,083 rows** on its 2026-08-03 success *and* on its 2026-08-10 and
2026-08-17 failures (`HTTP 402 — Payment Required`, an exhausted paid quota). Any `rows_written`-based health
read shows a flawless weekly pipeline. ⚠ Same family as the documented *"a byte-identical HTTP response is as
much the signature of a CACHE HIT as of a correct change"* — **the tell is the identity of the number, not
its size.** Diff the value against prior runs; a constant is a hypothesis, not health.

### 2b. The Dune spend budget — two meters, and one walk is 87.7% of the month

Dune bills two meters and the credits gauge on dune.com is **not** the one that stops us: it read ~900 of
2,500 on 2026-07-19 while the API was already answering `HTTP 402 … would exceed your configured datapoint
limit per billing cycle`. **Plan (operator-confirmed 2026-08-22): 1,000,000 datapoints + 2,500 credits per
cycle, resetting on the 24th (UTC).**

🚨 **The arithmetic that decides the whole design.** `ownership-sync-dune` walks every dune-sourced ownership
row: **146,100 rows × 6 columns = 876,600 datapoints = 87.7% of the entire cycle, in one run.** The weekly
cadence it has been on is not merely wasteful, it is impossible — and the 08-10 and 08-17 402s were simply the
second walk of a month meeting a limit the first had spent. No budget setting changes that; the ways out are
incremental mode (`DUNE_OWNERSHIP_INCREMENTAL`, needs a `{{set_ids}}` param on the Dune query), a monthly
cadence, or fewer columns (datapoints are rows × COLUMNS, so dropping one of six saves a flat 16.7%).

⚠ **Two numbers describe that walk and they are NOT interchangeable.** `pipeline_runs.rows_found` is what the
last EXECUTION returned (114,083); `count(*) from topshot_ownership where source='dune'` is the TABLE, which
accumulates across executions (146,100). The walk PAYS for the first, but the reservation must be sized to the
second — a reservation the workload outgrows fails silently, as a lane that stops starting. Inferring the
budget from `rows_found` understated it by 28% and shipped a `min_start` below the walk it was gating.

**Shipped 2026-08-22** — `dune_api_usage` (ledger, one row per call, written per PAGE), `dune_budget_state`
(policy + `paused` kill switch), `dune_budget_allocation` (per-lane), `dune_budget_status(pipeline)` (the
gate), `dune_spend_report()` (monitoring), and a **`Dune Spend (cycle)` sentinel arm**.

| lane | reserved | cap | min_start |
|---|---|---|---|
| `ownership-sync-dune` | 900,000 | 900,000 | 880,000 |
| `sales-ingest-dune` | 0 | 100,000 | 0 |
| `sales-seller-recovery-dune` | 0 | 100,000 | 0 |

- ⚠ **A reservation is protection from the OTHER LANES, not from a human.** Every other enabled lane's *unspent*
  reservation is subtracted from what a lane may take, which is what "ownership first" means mechanically. An
  ad-hoc query on dune.com still spends the same cycle and the ledger never sees it, so `datapoints_cycle` is a
  floor on real usage, never a proof of what is left.
- ⚠ **`min_start_datapoints` is the part that makes this safe for an ATOMIC walk.** The ownership walk restarts
  at offset 0 every run, so a partial walk spends the datapoints *and* leaves the table capped at the offset
  reached. The lane declines to start rather than buying 86% of a walk — `can_start`, not `allowance > 0`.
- ⚠ **The CREDIT meter zeroes the datapoint allowance too.** Credits are bought by `/execute` (one per window,
  ~10 credits est.) and are dominated by the CURSORED lanes — 37 + 43 window executions in one 2026-07-24
  morning. A lane that cannot execute can only serve a stale cached execution, which is the spend that buys
  nothing. `credits_per_execution` is an ESTIMATE (Dune prices by engine and we cannot read the charge back),
  calibrated at ~11 from ~900 credits over ~80 executions; it is reported as `credits_est_*` everywhere.
- **Fails CLOSED.** Unreadable, unconfigured, or a missing allocation row authorises zero. A tick stopped by a
  configured cap logs `ok=true` + `extra.budget_stopped` (pacing is not a failure); one stopped because the
  budget could not be READ logs `ok=false` (an unknown state must not report success).
- **Monitoring:** the sentinel arm warns on three independent conditions — spend ≥95% of the cycle, credits
  ≥90% spent, or a BURN RATE projected to exhaust before the cycle ends (spend% > elapsed% + 20). ⚠ The third
  exists because the second failure mode has no threshold breach until it is too late: two walks in the first
  days of a cycle read as "40% spent" and are already fatal. ⚠ The projection extrapolates the cycle average and
  its dominant term is one 876k walk, so it swings hard right after a walk lands — read it beside
  `cycle_datapoints_pct`, never alone.

⚠ **Re-derive the walk cost from the LEDGER, which keeps indefinitely** (`pipeline_runs` retains ~73h against a
weekly lane, which is why the 2026-08-03 design for this was blocked):

```sql
select occurred_at::date, sum(datapoints_est) as walk_datapoints, sum(rows_returned) as rows
  from public.dune_api_usage
 where pipeline = 'ownership-sync-dune' and endpoint = 'results'
 group by 1 order by 1 desc;
```

⚠ **`ownership-sync-dune` used to re-buy its whole cached execution on every failed refresh.** The route walked
`/results` "so the table is never emptied", but a failed refresh means `/results` returns the SAME execution
already ingested — which is exactly why §2 below sees a byte-identical `rows_written`. Since 2026-08-22 the
walk runs only when it can be shown to add something (empty table, or fewer rows held than the cached execution
carries, read with one `limit=1` probe); `?forcewalk=1` overrides. The honesty contract is unchanged: a stale
run is still `ok=false`.

### 3. An `ok` that ANDs every step's error slot can never be true if any step is EXPECTED to be cut off

`drain-conflated-subeditions` computes `ok = !fatal && !seed_error && !seed_recent_error && …`. Its design
deliberately runs the seed steps **last, behind a budget guard**, so they are routinely truncated and
`seed_recent_error` is set on essentially every run — pinning `ok` false forever. ⚠ **This hid a successful
REPAIR:** the 2026-08-15 "DRAIN before SEED" reorder took knot resolutions from **76 total / none since
2026-07-31** to **272 total with 196 in three days**, and rows/run from **0 → ~1,000** — and every one of
those runs still reported `ok: false`. ⛔ **Do not fix this by dropping the term from the conjunction** (that
trades a false negative for a false positive on TopShot keying). **A step stopped by design is not an error;
drain-success and seed-truncation are two different claims and need two fields.**

### 4. An ABSENT key is a cheap index seek; a PRESENT one is not — and that asymmetry makes "prove it is empty" tractable

Measuring the Top Shot fossil population looked impossible: five probes had timed out. The unlock was that
**6,561 absent-key probes returned instantly while enumerating 2,000 present keys took 20 s** (10.1 ms/seek,
`Heap Fetches: 1054/1999` — the visibility map does not pay off on a write-heavy table). ⚠ **So a
non-existence proof over a large table is often cheap even when the corresponding existence scan is not** —
seek for what should be absent rather than scanning for what is present. That plus a chunked loose index scan
enumerated all **11,799** distinct keys across three calls and settled a question recorded as unmeasurable.

---

## Two traps from the board-materialisation pass (2026-08-22/23)

### ⚠ A duration of exactly `0.0` on EVERY row of a pipeline is `now()` vs `clock_timestamp()`, not broken telemetry

`log_pipeline_run` stamps `finished_at` from **`now()`, which is frozen at transaction start**. A refresh
function that (correctly) captures `v_started := clock_timestamp()` *after* the transaction opens therefore
produces a `finished_at` a few milliseconds **BEFORE** its own `started_at`:

```
select round(extract(epoch from (finished_at - started_at))::numeric, 2) …
→ 0.00, -0.04, 0.00, -0.01, -0.01, 0.00, -0.02      ← always ≤ 0, never the real duration
```

**The real duration is in `extra->>'refresh_ms'`.** Three MV pipelines were read as "duration telemetry is
broken" off `finished_at - started_at` and were one step from being filed as a defect; the functions were
right and the *query* was wrong. ⚠ **The negative value is the tell** — a duration that is occasionally
*below zero* cannot be a measurement, so stop and find the real column instead of reporting the zero. Same
family as `rows_written = 0`: **an instrument reading zero is not evidence of anything until you have
established that it can read non-zero.**

### ⚠ Before changing how scheduled work is SELECTED, ask: does failing make the next attempt MORE likely?

This is the property that distinguishes the two changes made to the board-refresh subsystem on 2026-08-22.

- **The warm-tick rotation (reverted, took production down ~25 min).** The selector was *stalest board
  first*. Panini was both the slowest board and the paged one, so it was permanently the stalest → picked
  every tick → exceeded `maxDuration` → a 504 writes **no snapshot and no `pipeline_runs` row** → it got
  staler → picked again. **Failure fed the selector.** No steady state exists, and the average-case
  measurement that was taken (mean tick duration, which improved) is structurally blind to it.
- **The fixed-schedule MV crons (safe).** A refresh that times out simply leaves the MV stale; nothing about
  the miss raises that job's chance of running next. The worst case is bounded by
  `statement_timeout × ticks/hour`, and it degrades into an honest stamp plus a cadence alarm.

**So the check is not "is this faster on average" but "is there a term where failure increases future
selection".** If there is, a worst-case measurement is mandatory and the average is misleading. ⚠ Related:
when a cron command carries `SET statement_timeout = 'Ns'`, **N is a ceiling on WASTE, not on cost** — a
rolled-back refresh at the ceiling delivers nothing and still spends the IO. Size it just above the healthy
run, not at the pain threshold; the 600 s first chosen for the three board MVs let one job burn the full ten
minutes for zero rows during a spell.

## `backfill-topshot-pack-supply` / jobid 16 — instrumented 2026-08-23, and what it immediately showed

**Read the caller before designing the instrument.** The filing that prompted this work assumed
`mode=pool` runs on the background `EdgeRuntime.waitUntil` path and therefore prescribed an invocation
heartbeat plus kill-correlation. `cron.job` says otherwise: **jobid 16 sends `sync=1&limit=3&conc=1`** —
the INLINE path, which awaits `backfillPool` and returns real counts at 200. A single terminal
`log_pipeline_run` row is a complete instrument for it, and the heartbeat machinery would have been
unused code maintained forever. The background path keeps its documented residual (a killed worker
writes nothing, so absence means killed) and **nothing schedules it**.

| | |
|---|---|
| pg_cron job | **16** `rpc-backfill-pack-pool`, `3,8,13,…,58 * * * *` (**288 ticks/day**) |
| sibling | **15** `rpc-backfill-pack-supply`, `15 8 * * *`, `limit=400&conc=2`, `mode=supply` |
| pipelines | `topshot-pack-pool-backfill` · `topshot-pack-supply-backfill` (both new 2026-08-23) |
| deployed | v30 → **v32** (v31 was wrong — see below) |

⭐ **The telemetry was not the finding, and the function was already reporting it — to nobody.**
`net._http_response` retains the edge function's own JSON response body. Six hours of it, 2026-08-23:
**70 pool ticks, 67 of them `"ok":0` — 95.7% convert ZERO dists**, while
`pack_drop_pool.pool_source='gql_historical'` (this job's only output) last grew **12.4 h earlier**.
The work-per-outcome question that a filing called unanswerable was answerable from an instrument that
already existed. ⚠ **Before concluding a pipeline has no instrument, check `net._http_response` for its
response body** — for any `net.http_get`-driven edge function it is a free, retained, per-tick record of
what the function itself said.

**Why it looked healthy:** `if (!okPages || eds.length === 0) { fail++; return }` increments `fail`
**without setting `lastErr`**. A GQL walk that succeeds and returns zero editions is therefore a
failure with no error, and the tick returns `{"done":true,…,"ok":0,"fail":3,"lastErr":null}` — a clean
success. Now counted separately as `empty_eds`.

🚨 **v31 → v32: the instrument reproduced, in its own `ok` predicate, the defect it was built to expose.**
v31 logged `ok: !lastErr`. Its **first live row** read `ok=true` on a tick that spent **29,189 ms**, found
3 dists and converted **0**. v32: `ok` is false when targets were found and **none** converted, and the
error text is synthesized (`"0/3 dists converted; 3 returned no editions"`) so the condition is never
unfalsifiable. **Positive control on identical work — v31 `ok=true`, v32 `ok=false`** — which is the
proof the guidance in this file demands: show the instrument can see a FAILURE, not merely that it is green.

⚠ **Durable: check a new instrument's FIRST reading against something you already know is true.** Mine
disagreed with a measurement taken ten minutes earlier from `net._http_response`, and the **instrument**
was wrong, not the measurement. A new instrument that immediately agrees with your hopes has not been tested.

### ⛔ ROOT CAUSE of the 95.7% zero-conversion — the queue head cannot drain, and the sort key is a TIE

Measured 2026-08-24 immediately after the telemetry landed. The instrument only made the symptom
durable; this is why it happens.

`get_topshot_pool_backfill_targets` (SQL, SECDEF) is:

```sql
SELECT d.dist_id, d.metadata->>'uuid'
FROM pack_distributions d
WHERE d.collection_id = <TS>
  AND d.metadata->>'uuid' IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pack_drop_pool p
                  WHERE p.collection_id=d.collection_id AND p.dist_id=d.dist_id)
  AND (NOT p_only_with_rips OR EXISTS (SELECT 1 FROM pack_rips r …))
ORDER BY (EXISTS (SELECT 1 FROM pack_rips r …)) DESC,
         d.first_seen_at DESC NULLS LAST
LIMIT …
```

**Two independent defects compound:**

1. ⛔ **The only exit condition is "a `pack_drop_pool` row now exists".** A dist whose
   `packEditionsV3` walk succeeds and returns **zero editions** writes no pool row, so it is returned
   again on the very next tick — **forever**. There is no attempt counter, no cooldown, no
   unconvertible marker. jobid 16 fires 288×/day and re-serves the same unconvertible head every time.
   This is [[limit-before-join-starves-a-backfill]] in a different pipeline: *the dead head rows never
   leave.*

2. ⚠ **The sort key is a near-total TIE, so `LIMIT 3` is physical order, not progress.** Of the
   **709** unpooled targets, **350** have rips (so they all tie on the first `ORDER BY` term), and
   **322 share one single `first_seen_at` value — `2026-06-28 21:13:05.21`** (a one-shot seed batch);
   only **77** distinct `first_seen_at` values exist across all 709. Within the tie Postgres is free to
   return any rows, so this is CLAUDE.md's **"an unordered `LIMIT` is physical order, not a sample"**
   and the `.range()`-needs-a-UNIQUE-key rule, in a `LIMIT`-only query nobody thought of as paginated.

**Consequence.** ~288 invocations/day × 11–29 s of GQL pagination each, converting ~0. It is not merely
wasteful — `get_topshot_pool_backfill_targets` is one of the two RPCs the read-path attribution named as
**0.9% of calls / 14.6% of DB time** at ~1,657 buffers per call, so this wedge is a measurable share of
the instance's IO against a working set that already does not fit in `shared_buffers`.

⛔ **Do NOT "fix" this by writing a sentinel row into `pack_drop_pool`** — that table feeds pack-EV
hit-probability (`drop_weight / sum(drop_weight)`), so a marker row would corrupt a pricing surface to
fix a scheduler. The exclusion belongs on `pack_distributions`, not in the pool.

**The shape a fix needs** (unmeasured, therefore proposed rather than shipped — and it touches pack-EV
adjacent data, which is off-limits for autonomous shipping):
- record the attempt on `pack_distributions.metadata` (e.g. `pool_attempts`, `pool_last_empty_at`),
- exclude from the target query after N consecutive empty walks with a **cooldown** rather than
  permanently — an empty `packEditionsV3` is plausibly a delisted/expired listing, but that can change,
- **add a unique tiebreaker to the `ORDER BY`** (`d.dist_id`) so the queue actually advances,
- and keep the new `topshot-pack-pool-backfill` rows as the acceptance test: `rows_written > 0` on some
  ticks, and `empty_eds` falling.

⚠ **Until that lands, the honest reading of a green-looking tick is in the row itself:** `ok=false`
with `"0/N dists converted; N returned no editions"` is the *correct* report of a wedged queue, not a
transient upstream failure.

---

## `rpc-pipeline.yml` and the four endpoints nobody could see (register R68, 2026-08-29/30)

**The finding was TRIPLE blindness, not one green badge.** The workflow calls six production
endpoints ~3×/day and: (1) it was **six of six `continue-on-error`** with non-200 emitting only
`::warning::`, so 30 of 30 recent runs read `success` **by construction** — two steps did not even
test the status they captured, and one captured none; (2) **four of the six routes wrote no
`pipeline_runs` row of any kind**, with `fmv-recalc` as the positive control **in the same
instrument** (130 rows / 48 h against their **0**); (3) GHA log retention is finite.
**Jointly: the run frequency of four production endpoints was unknowable from any durable store.**

### `lib/pipeline/terminal-run.ts` — the sibling of `lib/pipeline/heartbeat.ts`

The heartbeat covers `after()` routes; this covers the other shape, a route that does its work inline
and returns, so its outcome is knowable when it responds. Written as a helper for the reason the
heartbeat's own header records: five routes once hand-rolled that contract and **no two agreed**.

⚠ **Its counters default to `null`, NEVER `0`.** A route that counted nothing must publish *not
measured*. This is only safe because `log_pipeline_run` stopped COALESCEing an explicit NULL to 0
(migration `20260829040000`).
⚠ **It cannot record a `maxDuration` kill** — the platform takes the terminal row with it, and
`try/catch`/`finally` do not save you. A route that can be wall-killed AND whose invocation frequency
must be knowable needs a heartbeat as well; the kill is then read by CORRELATION.
⚠ **A request rejected at AUTH writes nothing, deliberately.** The absence then means "never invoked",
covering both a schedule that did not fire and a token that drifted — they need the same
investigation, so collapsing them loses nothing.

### The gate, and why the threshold is "every endpoint failed"

Per-step tolerance is **kept** (one bad endpoint must not starve the rest — the 2026-06-25
restructure); a new non-tolerant step fails the job only when **all six** failed. Partial failure is
normal here and self-heals next tick; total failure is an outage (expired token, DNS, a bad deploy)
and had no signal at all. ⚠ **A missing status file counts as a FAILURE, not an unknown** — a step
killed by its own `timeout-minutes` writes nothing, which is precisely the case that must not read as
healthy. The gate also asserts it inspected `EXPECTED_STEPS` endpoints, so a shrunken list fails
rather than reporting a healthy count off a partial population.

✅ **THE TWO LAYERS WERE OBSERVED DISAGREEING, WHICH IS THE DESIGN WORKING.** On the 02:20Z
verification run the gate printed **`6 of 6 endpoints returned 200`** while `pipeline_runs` recorded
`ingest` **`ok:false`** on the same tick (Top Shot GraphQL 530). ⚠ **The job's green is honest about
what it measures — HTTP reachability — and is NOT evidence the pipeline worked:** `/api/ingest`
returns 202 from `after()`, so the 200 comes back before the work is attempted. **Read
`pipeline_runs` for health, never this workflow's badge.**

### Arming the watchlist rows — the trap this table's own history records

`detect_stalled_pipelines()` fires when `last_run IS NULL`, so **a row armed before its
instrumentation exists manufactures a false stall** (recorded in
`audit_20260802_arm_staged_watchlist_rows`). The five new rows were armed only after confirming rows
existed, and `detect_stalled_pipelines()` was re-read immediately after: same two pre-existing stalls,
none of the new ones.

⚠ **The threshold came from a measured distribution, not the nominal schedule** — see the GHA
correction above: **1800 m = 2.6× the measured 11.35 h max inter-run gap**. ⚠ **1800 is also a
CEILING, not just a choice**: the sentinel's `Pipeline Success Coverage` arm reads a 24–48 h window
and its own comment states the invariant that the window must stay wider than the slowest watchlisted
cadence. Anything longer makes that arm flap.

---

## A finished backward walk keeps running forever, and that is CHEAPER than retiring it (measured 2026-09-02)

`allday-sales-history-backfill` reached its spork floor on **2026-08-11** — `event_cursor
.allday_sales_v1_backfill` sits at exactly `137390146 = SPORK_FLOOR_HINT`. Its Vercel cron
(`7 */3 * * *`) has kept firing ever since: ~8 invocations a day that take the
`end < SPORK_FLOOR_HINT` early return, log `note: reached_spork_floor_hint`, write nothing and exit.
Roughly 154 no-op runs by 09-02.

The obvious cleanup is the one already applied to its sibling: `topshot-flowty-sales-history-backfill`
was **RETIRED 2026-08-16 — schedule removed from `vercel.json`, the ROUTE kept**, and its
`pipeline_cadence_watchlist` row set `is_active = false` with the reason written into `notes`. So the
precedent, the mechanism and the wording all exist.

⛔ **It was NOT applied here, and the reason is a number rather than caution.** The whole cost of
leaving it is **8 no-op lambda invocations a day** and one of 35 `vercel.json` cron slots. Against
that, removing the schedule means someone must restore it if the operator-gated spork-proxy ever lands
(the deeper 2021 → 2025-12-29 tail is only reachable through it). Near-zero either way, and churning
deployment config for near-zero is how a config drifts away from what anyone can explain.

⚠ **The enumeration that had to happen first, because it is the trap this repo has already recorded:**
the route ends with `fireNextPipelineStep("/api/cron/allday-resolve-unmapped")`, so deleting its
schedule also deletes 8 daily triggers of the unmapped resolver. That would have been the real cost —
except the resolver logs as **`allday-unmapped-resolver`** (not its route name) and is independently
fired by `allday-sales-indexer` at both of its exits: **79 runs / 1,698 rows in 24 h**, against the
backfill's 8. 👉 **Before removing a SCHEDULE, enumerate what the route FIRES, not just what fires the
route** — and search `pipeline_runs` by the pipeline's own logged name, which here matches neither the
route path nor the cron entry.

## ⭐ MOVING A JOB OFF PostgREST IS A REAL FIX — `rpc-topshot-onchain-rekey` (jobid 434), 2026-09-02

**What moved.** The Top Shot on-chain re-key (`remap_topshot_from_onchain_map()`) had
exactly one caller: the Vercel cron `/api/admin/drain-topshot-misattribution?rekey=1`
(`0 11 * * *`). That reaches it over PostgREST, where the Supabase **gateway** hard-caps
the request at ~120 s no matter what the function declares — and it declares 300 s, so
the declaration was unreachable on the only path anyone used it from. It is now pg_cron
**jobid 434 `rpc-topshot-onchain-rekey`, `33 11 * * *`, owned by `cron_heavy`**, calling
the thin wrapper `run_topshot_onchain_rekey()`. The `?rekey=1` param was dropped from
`vercel.json` in the same change; the route still supports it by hand.

**Why the move is the fix and not a workaround.** `cron_heavy.rolconfig` is
`statement_timeout = 600s` — five times the gateway cap, with no gateway in the path.
That is already how the sibling re-key (jobid 62 `rpc-remap-misattributed-sales`) runs,
which is why jobid 62 has never shown this failure and the HTTP one showed it on roughly
half its runs.

**What it cost while it was on the wrong path.** Five `rekey: upstream request timeout`
days between 08-23 and 08-28, and the audit tables gained **zero** rows on every one of
them — the gateway timeout is a **rollback**, so each of those ticks did ~1.4 GB of reads
on a 22 MB/s instance and kept nothing. The full control table and the read/write
asymmetry that made it missable are in
[database.md](database.md#-a-gateway-504-upstream-request-timeout-on-a-write-rpc-is-a-rollback--you-pay-the-full-cost-and-keep-nothing-proven-by-control-2026-09-02).

⚠ **Picking the minute is not cosmetic here.** The obvious `20 11 * * *` collides with
`rpc-allday-serial-fmv-power-model` (jobid 50, `20 11 * * 0`) and sits inside the Sunday
11:00–11:50 block that carries five weekly FMV multiplier jobs (`15/20/25/35/50 11 * * 0`).
`33` past the hour was chosen because the only thing it shares a minute with is an hourly
MV refresh (jobid 73, `3,33 * * * *`) that already coexists with everything. **Read the
weekly jobs, not just the daily ones, before picking a minute** — a weekly collision
shows up on one day in seven and reads as noise.

⚠ **The wrapper exists for OBSERVABILITY, and it has a stated hole.** `pg_cron` alone
records only `cron.job_run_details`; nothing in this repo's fleet sweeps reads that, so a
bare `SELECT public.remap_…()` schedule would have made the re-key invisible to every
`pipeline_runs` instrument. `run_topshot_onchain_rekey()` writes
`pipeline='topshot-onchain-rekey'` on both the success and the caught-error path (NULL
counters on the error path, never 0). 🚨 **But a `statement_timeout` kill writes NO row at
all** — an `EXCEPTION WHEN OTHERS` cannot swallow a statement-timeout cancel on this
database (already recorded in database.md; re-proved 2026-09-02 with a `SET LOCAL
statement_timeout='300ms'` + `pg_sleep(2)` DO block, and the `57014` propagated straight
out of the handler). So on a 600 s overrun this looks exactly like a job that never fired.
**Read it by CORRELATION against `cron.job_run_details` (status='failed'), never from the
absence of a failure row** — the same rule this file already states for `after()` kills.
Pinned by `supabase/tests/run_topshot_onchain_rekey.sql` (mutation-tested: publishing a 0
instead of NULL on the error path, a fabricated `rows_found = 0`, and removing the
exception handler each red it).

🚨 **AND IT DIED ON ITS FIRST TICK — 0.0 s, `permission denied for function`.** The
mandated anon hardening (`REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`) removes the
PUBLIC grant that is `cron_heavy`'s ONLY path to a new public function. ⚠ **This is the
FOURTH recorded instance of that exact trap** (two Pinnacle trade jobs and a series
rollup, all 2026-08-23) — see
[database.md](database.md#both-pinnacle-trade-cron-jobs-failed-on-every-run-from-creation)
for the full write-up, and note that migration `20260902113501`'s header wrongly claims
the conflict was undocumented. It was documented; it recurred anyway, because a paragraph
is read after you know your topic and this trap fires while you are thinking about anon
safety rather than scheduling. **So the deliverable is the check, not the note:**
`check_cron_heavy_job_exec_drift()` walks `cron.job` and returns `{inspected, offenders}`
(live: 56 / 0), **and it is wired into `/api/smoke-test` as a hard arm** — every push to
`main`, daily at 12:11 UTC, and 6×/day on the Vercel cron. It fails closed on an
unexpected payload shape and reports `inspected < 20` as a broken guard rather than a
clean run, because `offenders: []` from a walk that saw nothing is exactly the empty-set
pass this repo keeps re-finding. ⛔ **Still run it by hand after creating ANY function you
intend to schedule**, and pair the schedule with `GRANT EXECUTE … TO cron_heavy` — 48 of
the other 49 cron_heavy-called functions already carry `cron_heavy=X/postgres`.

✅ **Verified end-to-end through a temporary second `cron_heavy` job, since a
`cron_heavy`-owned job cannot be `cron.alter_job`'d from any session-reachable role** (the
limitation this file already records). It was unscheduled immediately; only jobid 434
remains. First successful run **75,803 ms**, `ok`, 0 sales / 0 moments re-keyed, 10
moments deferred on genuine collisions. ⭐ **63% of the ~120 s gateway cap, 13% of the
600 s ceiling it now runs under** — a job at 63% of its ceiling fails half the time from
IO contention alone, which is the entire diagnosis in one number.

## jobid 87 `rpc-refresh-challenge-costs` — 15% of its daily runs died at the CLUSTER default, invisibly (fixed 2026-09-02)

`20 7 * * *`, owner **`postgres`** — so no role `statement_timeout` applies and it runs
at this cluster's **default 120 s** (`statement_timeout = 120000`). It died at exactly
**120.0 s** on **8 of its last 52 recorded runs (15.4%)**: 08-14, 08-15, 08-18, 08-21,
08-23, 08-24, 08-26, 09-02. Successful runs took 30–120 s, i.e. it lived at its ceiling.

⚠ **Nothing watched it.** `refresh_challenge_costs()` writes no `pipeline_runs` row, so
the only witness was `cron.job_run_details` — which no sweep in this repo reads. And
because both of its UPDATEs sit inside one `SELECT refresh_challenge_costs()`, a timeout
in the second **rolled back the first**: on those 8 days nothing was refreshed at all and
`challenges.cached_cost_to_complete` / `cached_reward_value` silently aged another day.

**Root cause and fix:** 99.7% of the cost was a correlated scalar subquery against the
`DISTINCT ON` view `pack_ev_latest`, re-materialised once per challenge row —
**40,716 ms / 21,094,324 buffers**, for an arm that returns NULL for every row.
Hoisted into a single temp-table build it is **1,220 ms / 681,430 buffers**, and the
whole function now runs in **1.2 s** (verified live after apply: 31 rows, 1.208 s). Full
write-up, including the two alternative explanations that were ruled out first and the
control that was wrong on the first attempt, is in
[database.md](database.md). Pinned by
`__tests__/challenge-costs-pack-ev-lookup-stays-hoisted.test.ts`.

⭐ **The generalisable part is how it was FOUND**, and it is cheap to repeat: sweep
`cron.job_run_details` (retention here is ~55 days, 201k rows — far longer than
`pipeline_runs`' ~73 h) for jobs whose failures cluster at a single round duration. A
job that fails at *exactly* the same number every time is at a ceiling, not flaky.


## 🚨 A Next.js cron route can be SUPERSEDED BY AN EDGE FUNCTION and still look alive in the repo (2026-09-02)

`app/api/cron/compute-laliga-pack-ev/route.ts` was fixed, tested and mutation-tested for a real
truncation defect — and **it has not run since 2026-08-27.** ⭐ **And its live counterpart is not a successor** — the
edge function has run daily since **2026-07-29, four days before the route's first run**, so the
route was a redundant SECOND producer that was later switched off. **"Stopped" does not imply
"replaced", and the counterpart can be RENAMED** (`laliga` → `golazos`), so name-matching finds
nothing. The live Golazos pack-EV producer is a
Supabase **edge function**: pg_cron **jobid 44 `rpc-compute-golazos-pack-ev`, `37 */6 * * *`,
active** → `/functions/v1/compute-golazos-pack-ev`. The edge function does not share the defect; it
writes `pack_drop_pool` per dist and iterates the ~40 distributions it already holds from upstream.

### The one-query pre-flight, and where it belongs

**Before touching anything under `app/api/cron/`, ask whether it runs:**

```sql
SELECT count(*) AS runs_73h, max(started_at) AS newest
FROM public.pipeline_runs WHERE pipeline = '<pipeline-name>';
-- zero rows is not proof; pipeline_runs retains ~73h. Then:
SELECT count(*) AS days, max(day) AS last_day
FROM public.pipeline_runs_daily WHERE pipeline = '<pipeline-name>';   -- indefinite
```

Zero in the first and a stale `last_day` in the second is the signature of a **superseded** route.
⚠ **`pipeline_runs` alone cannot tell "never ran" from "ran outside retention"** — that is the
documented retention artifact, and it is why the daily rollup is the second half of the check.

### ⚠ THE MIGRATION IS INVISIBLE IN THE REPO

The route still exists, still compiles, still has tests, still has a heartbeat call, and its name is
still greppable. **Nothing in the source says an edge function took over.** The only evidence is
runtime: `pipeline_runs_daily` stopping on a date, plus a `cron.job` whose command points at
`/functions/v1/<name>` rather than `/api/cron/<name>`. Both halves of the fleet are in `cron.job`,
so **read the PATH out of the command** — not just whether a job exists:

```sql
SELECT jobid, jobname, schedule, active,
       (regexp_match(command, 'https?://[A-Za-z0-9._-]+(/[A-Za-z0-9/_.-]*)'))[1] AS path
FROM cron.job WHERE command ILIKE '%<name>%';
```

⛔ **Project only the PATH, never the command.** The query string carries the gate key, and a
truncating projection (`left(command, 140)`) has already leaked a partial one — a path-only regex
stops before the `?`.

### ⭐ A POST-DEPLOY CHECK THAT CAN ONLY CONFIRM IS NOT A CHECK

This was caught by verifying, not by reviewing. The before/after in `pack_ev_history` showed the
post-fix run writing **fewer** dists (23 vs 36–39), and chasing that disagreement is what surfaced
`rows_found: 40` and the absence of the run's own new `extra` field — i.e. **those runs were never
the fixed code's**. Had the number moved the flattering way it would have been recorded as verified.
**Design the post-deploy check so a wrong fix produces a different number, and then go and read the
number.**

⚠ And the first metric reached for was the wrong SUBJECT: `pack_ev_history` rows grouped by minute
look like "runs of my pipeline" and were another producer's. Same family as pairing a count from one
table with a property from another — **the fixed code was compared against someone else's output.**

### ⛔ AND STILL DO NOT DELETE IT

No pg_cron job and no in-repo caller reference the route. That is five of the eight caller sources
this file names — **cron-job.org and the Windows Task Scheduler on Trevor's box are invisible from a
sandbox**, and both are documented as real producers of production traffic. A dead-code candidate is
a filing, not a deletion.


### ⭐ The OUTPUT TABLE is a better liveness falsifier than the pipeline name

`pipeline_runs` tells you a NAME stopped logging. It cannot tell you whether the WORK stopped —
a driver can be renamed, and this repo has at least one case where it was. Checked two routes whose
names both went quiet on 2026-08-30, with opposite results:

| pipeline | last logged | its output table | verdict |
|---|---|---|---|
| `wallet-username-resolver` | 2026-08-30 | `wallet_usernames.max(updated_at)` = **2026-08-30 15:59:50Z**, the same instant | **stopped** |
| `topshot-deal-floor-serials` | 2026-08-30 | `edition_offers.low_ask_serial` current **today**, 1,469/1,479 rows in 7 d | **alive, renamed driver** |

👉 **Identical evidence in `pipeline_runs_daily`, opposite conclusions.** So the liveness check is two
steps, not one: the name tells you where to look, and **the table it writes tells you the answer.** An
output frozen at exactly the last logged run is about as unambiguous as this gets.

⚠ **And neither had a `cron.job` row**, so both were driven by something a sandbox cannot see
(cron-job.org, a GHA workflow, the Task Scheduler). ⛔ Which makes "re-enable it" the wrong call from
here: **re-enabling a schedule someone deliberately removed is the mirror image of leaving a broken
one dead**, and nothing visible from this side distinguishes them.


### The completed sweep: 14 quiet pipeline names → **2 real items**

Ran the pre-flight above across all 70 `app/api/cron/**/route.ts` files (52 distinct pipeline names)
on 2026-09-02. Fourteen had no runs. After triage:

- 🚨 **`wallet-username-resolver`** — genuinely stopped, `wallet_usernames` frozen at the same instant.
- ⚠ **`cadence-payer-balance-check`** — a monitoring gap: nothing watches the payer wallet balance.
- ✅ **The other 12 are fine, across SEVEN distinct causes:** dead upstream marketplace (×2), closed
  collection market, redundant producer switched off, **renamed driver (×3)**, feature-flag disabled
  (×2), retired data lane, static 4-row table, and **my own extraction artifacts (×2)**.

⭐ **≈86% false alarms, and the same rate in both halves of the list.** A "N pipelines have no runs"
list is a **reading list**, never a findings list — same precision ceiling as the static query-shape
scan (15 of 19 refuted the same day). Neither became a guard, for the same reason: at that rate a
guard is suppressed within a week and then reads as coverage.

### The two discriminators that did all the work

Neither requires understanding what the pipeline does:

1. **Query the table the pipeline WRITES.** Frozen at the last logged run → stopped. Current → the
   driver was renamed. This settled 5 of 7 in the "ran then stopped" group.
2. **Read the route's actual `log_pipeline_run` call.** ⚠ **The pipeline name often does not match
   the directory name** — `app/api/cron/sync-sales-ingest-dune/` logs as `sales-ingest-dune`, and
   `app/api/cron/sales-serial-backfill/` logs as `sales-serial-backfill-trigger` while the *edge
   function* logs the real work as `sales-serial-backfill`. Two of the fourteen were my own
   extraction artifacts because of exactly this.

⚠ **"Renamed driver" was the single most common real cause (3 of 12).** Assume it before assuming a
defect: `refresh-cross-collection` → `cross-collection-deals-mv`, `sales-serial-backfill-trigger` →
`sales-serial-backfill`, `compute-laliga-pack-ev` → `compute-golazos-pack-ev`.
