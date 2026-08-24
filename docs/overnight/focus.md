# Focus — 2026-08-17 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## PRIORITIES — what tonight's pass should weigh

1. ✅ **CAPTURED 2026-08-23 22:05Z — the four-week gap is closed, so do not re-ask for it; re-MEASURE it.** **21 accounts** (was 20 on 07-26, so **+1 in four weeks**), **0 signups in 7 d** (newest 2026-08-08), **signed-in WAU = 0**, MAU = 2. Roadmap gate is 50+ WAU. ⛔ **Do NOT read `funnel_events` sessions as users — that instrument is wrong by ~3 orders of magnitude**: 16,463 weekly "non-bot" sessions of which **99.67% fire exactly one event and never return**, 4 `wallet_paste` sessions, 0 `signin_click`, 0 `account_created`. ⚠ **Vercel Web Analytics is NOT enabled**, so `funnel_events` is the only traffic instrument and has no independent corroborator. ⚠ **`bot_ua` is only meaningful from 2026-08-23 02:00Z forward** — before that the column exists with no UA to classify, so `false` means "never saw one", not "human". Full capture, with the accuracy gate alongside it: [inbox 2026-08-23T2205Z](inbox/2026-08-23T2205Z-priority-1-captured-wau-is-zero-and-the-accuracy-gate-is-30-percent.md). **Demand is still the gate that matters and the roadmap's answer to a 0 is ACCURACY FIRST, not growth tactics.** ⭐ **And the accuracy gate is measured too, for the first time: 30.1% HIGH/MEDIUM** (Top Shot 34.3%, All Day 21.4%, Golazos 0.0%, UFC 0.0%, Candy 61.6%) — ⚠ **excluding Pinnacle, which has ZERO rows in `fmv_current`** and prices through its own triple-keyed path, so the headline covers four of five published collections. ⛔ **Do NOT chase Golazos' 0%** — measured, every edition that sold there has **1–3 sales a month (avg 1.4)**, so a threshold change would manufacture confidence, not accuracy. ⭐ **The gate is mostly a LIQUIDITY CEILING, not an engineering defect:** on All Day, confidence tracks volume monotonically — HIGH averages 11.8 sales/30d and **100% have ≥5**, MEDIUM 5.5, LOW 2.6. 🚨 **THAT QUESTION IS ANSWERED AND IT IS BIGGER THAN IT LOOKED: ~1,000 editions estate-wide are labelled LOW while their own `sales_count_30d` is ≥5, and in EVERY collection the LOW cohort trades ~2× the MEDIUM cohort** (Top Shot 499 editions at avg 28.9 vs MEDIUM 15.2 vs HIGH 14.0; All Day 454 at 15.6 vs 9.3 vs 9.4; Candy 44 at 48.1). Controls rule out staleness (145/150 computed in 24 h), legacy algo (137/150 are `1.7.0`, same as MEDIUM) and my own query (the figure is the pipeline's own column). `computeConfidence` makes LOW the floor case, so the rule says this cannot happen. **Two readings, both defects:** the LABEL is wrong (~+2 points on the gate, and we publish our lowest confidence on the editions users look up most), or the COLUMN is wrong (`sales_count_30d` may hold the 90-day widened count — it reads 12.7 where a raw 30 d count reads 7.6). ⭐ **RESOLVED the same evening — and it is a CALIBRATION question, not a bug.** Re-measured from `sales` directly (never the column): **368 Top Shot editions publish LOW on a TRUE 39.6 sales/30 d average vs MEDIUM's 22.2**, all 352 current-algo ones computed within 24 h, `days_since_sale` 4.7, true counts 5 → **643**. The cohort is **sub-$2.50 WNBA Series 8 moments at 5/5 liquidity** — a **$0.49** FMV built from **643 trades** publishes as LOW. The demotion is **BY DESIGN**: `MEDIUM_MAX_DISPERSION = 0.35` demotes MEDIUM→LOW once count ≥7, so only high-volume editions are even eligible. ⚠ **Dispersion is RELATIVE; the marketplace tick is ABSOLUTE** — the repo's own dust-filter doc puts the price mode at the **$0.25 minimum**, so at $0.33–$0.71 one tick is a **35–75%** swing. ⛔ **Do NOT raise the ceiling** (it does real work at dollar scale) and ⛔ **do NOT bulk-promote**. ⚠ **Last step NOT done — two attempts timed out at 60 s mid-sweep:** per-edition `stddev_pop(price)/avg(price)` over 30 d, grouped by confidence, split at `avg(price) < $1`. Run it quiet. Filing: [inbox 2026-08-24T0225Z](inbox/2026-08-24T0225Z-a-thousand-editions-are-labelled-LOW-while-they-are-the-most-traded-on-the-platform.md).
2. **Prefer DB/artifact work that does not need a push.** Cloud-sandbox passes have repeatedly been NO-PUSH. Work that lands as a migration or an artifact ships; work that needs a git push may not. (⚠ Push from Trevor's **local** box is fine — verified 2026-08-17 — so a NO-PUSH night is a *sandbox* limitation, not a repo one.)
3. **Do not open new investigations into disk-IO saturation symptoms.** The fmv-recalc kill rate, `public_board_slow_count`, the board-warm failures, the pg_cron statement-timeouts and the `get_collection_stats` timeout are **one root cause** (disk-IO budget on the SMALL 2 GB instance). The lever is cutting work — page size, precompute, fan-out — **never** raising a timeout and never upgrading the tier.

## STEER — added 2026-08-22 (a long interactive day; these change what the next pass should and should not do)

- 🚨 **`job startup timeout` now has a NAMED CAUSE — stop treating it as ambient.** `max_worker_processes = 6`
  against `cron.max_running_jobs = 32`; pg_cron cannot get a background worker, so the body never runs
  and **nothing reaches `pipeline_runs`**. 169 timeouts / 28 jobs in 24 h. Detail + the hour table:
  [cron-and-schedulers.md](../reference/cron-and-schedulers.md).
- ⛔ **BUT DO NOT extend that to the 01:00–19:00Z band.** Measured 08-22: pg_cron **run count is FLAT all
  day** (480–552/hr) while busy-seconds swing **10×**. The band is not caused by scheduling density —
  it is the same work taking longer (burst-credit depletion). **Staggering fixes an individual job and
  the startup-timeout class, NOT the band.** Anyone proposing "stagger the crons" as a band fix has
  mis-read this.
- ⛔ **Before planning ANY `cron.alter_job`, read `cron.job.username`.** 42 of 93 jobs are owned by
  `cron_heavy`, and **no session-reachable role can reschedule those** (`postgres` may EXECUTE but does
  not own; `cron_heavy` owns but may not EXECUTE; `postgres` cannot UPDATE `cron.job`). The ledger's
  08-22 success on jobids 83/84 was on `postgres`-owned jobs and does not generalise.
- ⚠ **`pinnacle-sync`'s cadence arm was DEACTIVATED and replaced by `pinnacle-fmv-recalc` @ 1560 min.**
  The old arm watched a best-effort log line whose write is swallowed by design; the work is fine. **Do
  not re-activate it** — and note the new arm is blind to "the 10:07Z HTTP caller stopped", which the
  22:37Z pg_cron backstop makes invisible to users anyway.
- ⚠ **`wallet-username-resolver`'s cadence arm is 450 min now (was 75).** Trevor cut the cron to every
  3 h on 08-18 and the arm was never re-pointed, so it fired on every tick. Its **failure rate is a
  separate, still-live problem** (84% via the pooler) — the cadence arm is structurally blind to it, so
  do not read a quiet cadence arm as a healthy resolver.
- 🚨 **OPEN, OPERATOR-ONLY, and none of it is fixable from a sandbox:** pg_cron **jobid 70** is the SOLE
  refresher of `mv_topshot_misattrib_candidates` and has failed 15 of 16 runs since 08-07 (the MV is
  stale since 08-16) — the one-line fix is blocked by the ownership split above. **atlas-proxy** still
  needs a `wrangler deploy`. **`topshot-moments-hydrator`'s cron is declared in NO repo file** and a
  `wrangler deploy` would delete it. And the **P0 stale branch `e4tib3`** still carries the pre-purge
  credential blob on a public repo.
- ✅ **Two new CI guards exist; do not duplicate them.** `check-memory-doc-links.mjs` (CLAUDE.md +
  `docs/reference/**` pointers) and `check-driver-message-leaks.mjs` (ungated handlers returning
  `err.message`). Both are ban-at-population-zero and both carry their own inspected-count assertions.

## STEER — added 2026-08-23 (interactive; verifies one standing instruction and re-opens one it closed)

- ✅ **The `db-pin-staleness` verification this file ASKED FOR was run, and the answer was NOT the predicted
  "187 clean, 0".** The 08-23 07:51Z run reported **189 pins — 187 clean, 2 needing attention**, naming
  `refresh_cross_collection_cohort_step1` / `_step2` — a **DIFFERENT pair** from the six closed the evening
  before. The 08-22 ~20:35Z lock-window rewrite shipped its own new pin file and left those two pointing at
  the superseded 08-16 snapshot, so the instrument re-opened hours after #24 was closed. Both are now
  re-pinned, and a third (`log_pipeline_run`, from the same-day `clock_timestamp()` fix) with them.
  **VERIFIED GREEN by workflow_dispatch at 20:31Z: `checked 189 pins — 189 clean, 0 needing attention`** —
  the sweep's first green since 2026-08-09. ⚠ **The durable lesson is that #24-style closure is not a state,
  it is a moment: any migration that redefines a pinned function re-opens it the same day.** Re-pointing a
  pin is part of shipping the change, not a follow-up chore.
- 🚨 **`migration-parity` went RED on 08-23 07:58Z — its FIRST failure after 14 consecutive greens** — and
  the gap **re-opened behind this morning's recovery**. Measured 20:30Z: 61 migrations applied since 08-21,
  **17 with no committed file**; I committed the one I needed, so **16 remain**, fifteen of them applied
  17:29–19:28Z as one still-moving `series_detail_rollup` / `edition_fmv_current` piece. ✅ **CORRECTED 20:50Z — RUN THE
  SCRIPT.** My first version of this steer said do not reconstruct them, reasoning from
  `pg_get_functiondef`. Wrong: `supabase_migrations.schema_migrations` **stores the applied statements**, and
  **`scripts/recover-fileless-migrations.mjs`** (written this morning, `307ce25e`) writes each file
  byte-exactly and verifies it against the md5 prod computes. It needs `SUPABASE_SERVICE_ROLE_KEY` — which is
  why I did not run it from this sandbox — and it never commits. Only the **authored header and revert
  block** still belong to the session that applied each migration. ⚠ Scan the stored statements for
  secret-shaped content first; I did, and all sixteen are clean. ✅ I dispatched `migration-parity` on demand
  at 20:43Z so the sixteen are named in a log now rather than at 07:40Z. Filing:
  `docs/overnight/inbox/2026-08-23T2030Z-sixteen-more-migrations-applied-today-still-have-no-committed-file.md`.
- ⚠ **NEW DB TRAP, and it is general: on PostgreSQL 17 a partial index whose predicate says
  `col IS NOT NULL` on a column declared `NOT NULL` is UNREACHABLE.** PG 17 removes the redundant qual before
  partial-index predicate proving, so the planner drops the index from the candidate set entirely — not
  out-costed, invisible. A strict clause on that column (`col = $1`, `col <> $1`) restores it. Three of the
  six such indexes here are dead, including the **98 MB `idx_sales_2026_fmv_recalc_window`** that
  `fmv_recalc_edition_page` needs: made reachable it runs the same 30-day window **2.9× faster on 2.0× fewer
  buffers**, and at the real 90-day window it completes in ~16 s where the as-written form does not complete
  in 60 s. ⚠ **`idx_scan > 0` is NOT evidence of reachability** — `idx_sales_2026_top_sales_board` has 502
  recorded scans and is unreachable today, so the unused-index advisor is structurally blind to this class on
  exactly the indexes that used to work. **Repair is an index rebuild (DDL on the FMV path) → Trevor's call,
  not a night-pass item.** Evidence:
  `docs/overnight/inbox/2026-08-23T2130Z-postgres-17-makes-partial-indexes-with-is-not-null-predicates-unreachable.md`.
- ✅ **A 24 h Vercel runtime-error sweep (21:56Z) found NO new honesty-canon instance — recorded so nobody
  re-sweeps it tonight.** 50 error groups; every one resolves to **saturation collateral** (statement
  timeouts, pool-acquire timeouts, `maxDuration` kills) or to **honest degradation working as designed**. The
  `[pack-detail] …` and `[entity-section] … — degrading to empty` families in particular are the R19 pattern
  firing, not a defect: `lib/pack-dist/fetchers.ts` returns `{ ok: false }` and the page consumes it through
  `summarizeDegraded(boardStatus(…))` at every one of those sections. ⛔ Per PRIORITY 3, none of this is a new
  investigation.
- ⚠ **BUT COUNT-BASED TRIAGE OVER `[pack-detail]` READS DOUBLES, and the pairs are exact.** Every bound breach
  logs **twice**: `bounded()` in `lib/pack-dist/fetchers.ts` catches the timeout and logs
  `[pack-detail] <label> bound …`, then returns `{ error }` so the caller's own `if (error)` branch logs
  `[pack-detail] <label> error …`. Measured, not inferred — six labels, identical counts in both groups:
  `pack_lifecycle` **138/138**, `pack_realized_ev` **129/129**, `ev_contributors` **126/126**,
  `pack_sales_history` **75/75**, `pack_table_rows` **59/59**, `pack_distributions` **50/50**. **Read one of
  each pair, never their sum.** Both lines carry different information (the bound fired / the caller handled
  it), so this is noise rather than a lie — **not touched**, because that file shipped hours ago and belongs
  to the session still working it.
- ⚠ **A retraction, so nobody re-derives it:** the 20:00Z `fmv-recalc` filing claimed `(saturation-class)` was
  a misattribution "because the database was measurably quiet". **Withdrawn** — that reading was taken at
  19:50Z and applied backwards to failures at 17:48–18:49Z, while the daytime monitor's positive control at
  18:10Z reads `io_wait=12 / active=11 / total=46`. **A control must be contemporaneous with what it
  controls.** The structural half stands and is now stated in **buffers**, which load cannot move.

## STEER — do NOT re-flag these (current)

- **The three standing trust breaches are all known-class.** `panini_sale_price_capture_dry_days` (an arm that is **crying wolf** — it counts dry days on a field deliberately abandoned and replaced on 08-08, while the replacement works at ~22%; the fix is to RE-POINT the arm, not to chase the capture), `unmapped_resolution_backlog_max` (AllDay permanent floor — its own text says do NOT raise `breach_at`), `public_board_slow_count` (saturation collateral; **do not characterize its direction from fewer than several days** — it has been called both "climbing" and "oscillating down" on ~1-day windows and both were fair).
- **Sentry issues titled `smoke check could not run: …` are the honest-degradation path WORKING**, not security failures. Verify against the live invariant (`check_public_security_invariants()`, `check_anon_write_surface()`) before treating one as a breach.
- **`rpc-topshot-pack-opens-history` returning `done: true` ~96×/day is a DELIBERATE STANDBY.** It looks like a dead cron on every instrument. Do not unschedule it.
- **SERIAL-FMV-MULT-CRON — BY DESIGN.** `serial_fmv_multipliers` and `serial_fmv_power_model` refresh **weekly** via pg_cron. Staleness ≤7d is expected; do not re-queue as an escalating cron-silent item.

## ⚠ DO NOT ARCHIVE `docs/overnight/inbox/` FILES (measured 2026-08-17 — a queued action that would have broken things)

The `inbox/` convention says files are "archived to `inbox/archive/` after draining", and the 08-17 handoff had ~40 Aug 9–14 files queued to archive "once push is restored". **Do not run that.** Those files have become **permanent citation targets**: they are referenced by exact path from `CLAUDE.md` (4), `docs/overnight/ledger.md` (many), a dozen handoffs, the roadmap, `docs/sessions/2026-08.md`, **four committed `supabase/migrations/*.sql` files**, and **`lib/analytics/rpc-with-retry.ts:268`** (live product source). Moving them breaks every one of those, and migrations are immutable history that must not be edited to chase a path.

Evidence this has already bitten: `inbox/archive/2026-08-10T0515Z-…md` cites `inbox/2026-08-09T1941Z.md` — an already-archived file pointing at a still-live inbox path.

**The convention and the citation practice are in conflict, and the citations win.** Treat `inbox/` as append-only. If the directory's size becomes a real problem, the fix is a redirect/stub or an index — not a `git mv`.

## STANDING (added 2026-06-22 — do NOT drop on the next focus rewrite) — pg_cron failure check

Every monitor + night-pass health sweep, also run `SELECT * FROM check_pgcron_recent_failures();` — this surfaces the pg_cron-internal failure class that `detect_stalled_pipelines()` CANNOT see (it watches `pipeline_runs`, not `cron.job_run_details`). Empty array = all pg_cron healthy. A listed job is a real finding **only if its `last_run` is AFTER the relevant same-day fix landed**; a failure timestamp that predates a fix is a STALE pre-fix run that clears on the job's next tick — do NOT alarm on it. A genuinely-recent pg_cron failure = HIGH-PRIORITY inbox candidate. (Also permanent in both task SKILL.md health-sweep sections; this note is belt-and-suspenders.)

## SENTINEL DECISION-QUEUE (2026-08-17 PT) — dispositions, so nobody re-derives these

The queue's own warning was that **re-derivation is this project's recurring cost**, and three of its five
items had already been measured elsewhere. Current state:

- ✅ **Item 5 (`pinnacle-nft-resolver`, ~900 null-edition rows) is CLOSED — it is the 08-15 catalog gap.**
  `pinnacle_sales.edition_id` FKs to `pinnacle_editions` (551 rows); the editions live only in
  `pinnacle_catalog` (2,561). Re-measured 08-18T0112Z: `distinct_editions=161 · in_editions=0 ·
  in_catalog=161`, up from 114 on 08-15 (**+41 % in three days**). Filed:
  `inbox/2026-08-18T0112Z-pinnacle-null-edition-pool-is-the-catalog-gap-…md`.
  ⛔ **Do NOT "park the unresolvable rows"** — they are not permanently unresolvable, and parking them
  hides a widening gap. ⚠ The resolver's `failed: 0` means it **never reaches** these rows (946 of 954
  have `resolution_attempts = 0`), not that it declines them gracefully.
- ⏸ **Item 1 (pack-EV `fmv_current` JOIN) — mechanism CONFIRMED, still correctly unshipped.** Fully
  measured already in `inbox/2026-08-16T1829Z-fmv-current-does-not-push-down-through-distinct-on.md`
  (~3,100× — 335 buffers vs 1,046,192). ⚠ **The queue framed this as one coordinated migration because
  "the function is pinned AND two of three are unmeasured". Those two facts are DECOUPLED — verified
  08-18 — and splitting them makes the expensive half shippable on its own:**

  | function | pinned? | measured? |
  |---|---|---|
  | `compute_pack_ev_per_edition_weighted` | **YES** — `supabase/tests/compute_pack_ev_per_edition_weighted.sql`, PINS entry at `__tests__/db-invariants-drift-guard.test.ts:170` | **YES** — jobid 71's callee, confirmed by the timeout CONTEXT; ~100 min/week of `cron_heavy` for zero rows |
  | `compute_pack_ev_from_pool` | no pin file | no |
  | `compute_pack_ev_from_pool_tier_weighted` | no pin file | no |

  So the **pinned one is the measured one**, and it is the one actually burning the budget. It can ship
  alone (migration + pin `.sql` + repoint the PINS migration name); the two unpinned ones need
  measurement but **no pin work**, and must not gate it. ⛔ Never `CREATE OR REPLACE VIEW fmv_current`
  (resets `security_invoker`); fix the CALLERS via a lateral accessor. Measure in a quiet window —
  during a saturation spell no timing is interpretable.
- 🔑 **Item 2 (`wallet-username-resolver`) is OPERATOR-ONLY — it is not pg_cron.** Caller enumerated
  08-18: absent from `vercel.json` (36 crons), pg_cron (94 jobs), GHA and in-repo fetches. It is
  **cron-job.org**, firing `POST /api/cron/resolve-wallet-usernames` 2×/hour. Trevor chose lever (a),
  cut the cadence → **every 3 h**. Sizing: 72.3 % of runs fail, and the failures still pay the full
  21-day `sales` scan before `wallet_usernames_unresolved`'s `statement_timeout=60s` kills them, for
  ~31 usernames/day. ⚠ Cadence only — **do not narrow the 21-day window** (breaks the 14-day retry).
- 🔍 **Item 3's lever is NOT the index alone.** The cost is in `aggregate_saved_wallet_stats`, whose
  `top_tier` **correlated subquery re-scans `wallet_moments_cache` once per `collection_id`**, and no
  index carries `tier` (confirmed: 14 indexes, none include it; `idx_wmc_cohort_cover` is now **464 MB**,
  not 458). Fold the subquery into the existing `GROUP BY` before considering a wider index — a fold
  costs no write amplification on a 98 %-non-HOT table.

⚠ **Measurement hygiene, learned the hard way 08-18:** the Supabase MCP 60 s cap abandons the RESULT, not
the query — a "timed out" EXPLAIN keeps running (seen at 86 s) and retrying it stacks copies onto the
saturation being measured. Take a positive control first (`count(*) FILTER (WHERE wait_event_type='IO')`
over `pg_stat_activity`); if most active sessions are in IO wait, **every duration that hour is
uninterpretable** — compare Buffers, never wall time.

## STANDING — read the three daily instrument LOGS, not their badges (added 2026-08-22)

Three credentialed detectors run daily and are the only things that can see their rot classes:
`edge-fn-drift` (06:40Z) · `db-pin-staleness` (07:20Z) · `migration-parity` (07:40Z). **Measured 2026-08-22:
edge-fn-drift red 14 consecutive runs, db-pin-staleness red 13, migration-parity 14/14 green — and BOTH red
ones are LOUDLY CORRECT, not broken.** 25 edge functions are not running `main`; 6 of 187 DB pins no longer
match live. Details: known-issues **#23**, **#24**.

⚠ **Nothing surfaces them (#25).** The sentinel — the thing actually read — has no GitHub Actions arm, so a
correct detector can stay red indefinitely and nobody notices. Until that is fixed, **reading these three
logs is a MANUAL step in any health sweep**, and CLAUDE.md's rule applies literally: *check the LOG, not the
badge* — a permanently-red instrument and a broken one look identical.

✅ **#24 is RESOLVED as of 2026-08-22 — all six pins re-pinned, assertions reviewed, not merely repointed.**
The warning that stood here (repointing without reviewing the assertions converts a working alarm into a
silent green) was honoured: every pin got its own diff, and five gained mutation-tested assertions for the
behaviour that had drifted. ⚠ **VERIFY, do not assume:** the 07:20Z `db-pin-staleness` run should now report
**187 clean, 0 needing attention** — its first green since 2026-08-03. If it names a pin instead, read WHICH
before reopening. 🚨 **IT DID NAME PINS — this prediction was FALSIFIED on 08-23 and the reason is durable;
see the 2026-08-23 STEER above.** Closure is a moment, not a state: a same-day rewrite of a pinned function
re-opens the instrument within hours. Recipe + what the six taught: [database.md](../reference/database.md).

⚠ **#23 and #25 remain OPEN and are operator-blocked.** 25 edge functions are still not running `main`
(redeploy needs both `deno.json` in `files` AND `import_map_path`, or a stale-but-working function goes
hard-down — and the list includes off-limits `compute-*-pack-ev` / `ingest-*`). Nothing still reads the
daily detectors; that fix is a sentinel arm keyed on a failure STREAK, blocked on putting a GitHub token
with `actions: read` into Vercel env.

## DECIDED 2026-08-22 — two open decisions closed, so nobody re-opens them

- ✅ **pg_cron jobid 70 / the `cron_heavy` privilege question: do NOT grant, no grant is needed.**
  `postgres` IS a member of `cron_heavy`, and `cron_heavy` already holds EXECUTE on `cron.schedule` and
  `cron.unschedule` — only `cron.alter_job` is missing, and `cron.schedule` upserts on
  `(jobname, username)`, so rescheduling under the job's own role updates it in place. Granting
  `alter_job` would widen a privilege to buy a capability the role already has by another door.
  ⚠ **The blocker is the HARNESS, not the database** — the Claude Code auto-mode classifier denies
  `SET ROLE`. The two-line self-checking recipe (and what to do if it returns a jobid other than 70) is
  in **known-issues item 19**, which has been corrected: its old "NO session-reachable role can
  reschedule" headline was **REFUTED**. **Transferable:** *"the sandbox could not do it" is not evidence
  that the DATABASE forbids it* — that conflation turned a two-line fix into a privilege-grant proposal.
- ✅ **The FMV-confidence accuracy meter: the destination is a NIGHTLY MATERIALISED TALLY**, not a
  cheaper in-band query. Rationale in §7 of
  `inbox/2026-08-22T1745Z-the-headline-accuracy-metric-is-unreadable-20h-a-day-…md`. The short form: a
  3.3× cheaper query still runs in-band and can still be killed in a spell — it lowers the odds without
  removing the dependency; and **a GATE metric needs a SERIES, which the in-band rewrite does not
  provide at all**. ⚠ **The lateral rewrite is NOT the alternative — it is the tally's WRITER**, so the
  23:10Z measurement (`trig_01H3p6o5iB7yyjLVzrbbviaA`) keeps its full value and has been repointed at
  that question. ⚠ **The tie check is now BLOCKING**: a tally is computed once and read all day, so an
  arbitrary tie-break is frozen into the published number. ⚠ **New third state for the redesign:
  STALE** — a stored tally that silently ages is worse than a query that loudly times out, because a
  timeout is falsifiable. Nothing has shipped: no table, no writer, no migration.

## RETIRED STEERS — these were in this file and are now WRONG; do not re-add

- ⛔ **"TS on-chain unmapped spike — do NOT skip/retire this class."** `topshot-flowty-unmapped-drain` was **deliberately RETIRED 2026-08-16** (schedule removed from `vercel.json`, verified absent) because its queue reached **0 open** and proving emptiness cost a full backlog scan on ~73 ticks/day. The old steer now argues against a decision that was correctly made.
- ⛔ **"evm-transfers-ingest Base-429 — benign, don't chase."** That cron was **disabled 2026-08-02** as pure waste (`evm_nft_transfers` holds ZERO rows; absent from `vercel.json`, GHA and pg_cron). There is nothing left to not-chase.
- ⛔ **"`unmapped_resolution_backlog_max` self-clears <100 in ~1–2 days."** It did not. It is **291** and is now understood as an AllDay **permanent-class floor**, continuously replenished. Do not wait for it to clear and do not raise its threshold.
- **The whole 2026-06-24 studio-platform post-ship watch** (3 backfill routes, the watchlist follow-ups, the TS dead-media tail, the spork-proxy correction, the UFC studio resolver) — all shipped and long since folded into `CLAUDE.md` + the ledger. Kept out of this file to stop it decaying into an archive again.
