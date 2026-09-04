# Focus — 2026-08-17, steers appended through 2026-09-03 (accuracy-gate phase; the June studio-platform program is HISTORY)

⚠ **This file was 54 days stale until 2026-08-17** (it was still the 2026-06-24 studio-platform post-ship watch). That is not merely untidy: three of its steers had gone **actively wrong**, and a night pass following them would have been misdirected. The obsolete steers are listed at the bottom under "RETIRED STEERS" with the reason each died, so nobody re-adds them from an old copy. The June program's detail is **not lost** — it lives in `docs/overnight/ledger.md` and `docs/handoff-2026-06-24-studio-platform-gql-deep-history.md`.

**Rewrite rule for whoever edits this next: a focus file STEERS the next night, it is not an archive.** If a section is describing something that shipped more than ~a week ago and is not still a live trap, move it to the ledger and delete it here. A stale steer is worse than no steer.

## STEER — added 2026-09-03 (Trevor's box, interactive; six "findings" re-derived, four ships — read before the 09-04 pass drains anything)

1. ⛔ **Do NOT re-file `topshot_impossible_parallel_serials`.** The 09-03 daytime filing's "NEW HIGH regression at 8" was the self-healer's routine inflow, read at :48 and healed at :52 on the same cadence. **Jobid 219 now heals at `:43 0,6,12,18`, BEFORE leg 324 reads at `:48`** (migration `20260903221540`). From 2026-09-04 00:48Z the arm reports the post-heal RESIDUE: a persisting nonzero is real (a timed-out heal, a `circulation_count = 0`, or a writer out-running four heals a day); the inflow rate lives in `impossible_parallel_circ_raises`. ⚠ The arm's in-view description still says "pages a future regression" — the correction is in `trust-board-and-safety.md`, not in the view.
2. ⛔ **Do NOT raise `candy_scarcity_board.max_ms`.** The board is MATERIALISED (`mv_candy_scarcity_board`, pg_cron **436** hourly at `:26`, 300 s; migration `20260903221326`); the wrapper reads 4 buffers. `max_ms` stays 3000 — a reading near 3 s again means the wrapper stopped reading the MV. Watch: `board_mv_refresh_stale_hours` now includes it at 6 h.
3. ⭐ **wmc REINDEX is weekly maintenance now:** jobids **438–441** (`3 2` / `23 2` / `43 2` / `3 3 * * 0`, cron_heavy, one bare `REINDEX INDEX CONCURRENTLY` each) + **442** verify (`23 3 * * 0`). **First reading: Sunday 2026-09-06 03:23Z `wmc-reindex-verify` row, exit = `ok=true`.** ⚠ A pg_cron `failed` on 438–441 is NOT the falsifier (REINDEX CONCURRENTLY commits outside the block); `invalid_left` on the verify row means a `<index>_ccnew` to drop by hand as ONE bare `DROP INDEX CONCURRENTLY IF EXISTS`. If `idx_wmc_cohort_cover` is ever dropped, unschedule 441 in the same pass. Register #56.
4. ⛔ **`allday-pack-opens-backfill` is not wedged, and there is nothing to ship.** It walks DOWN (a falling `scanned_floor` is progress); `status 0` is its own documented abort budget on the spork proxy (41 of 98 runs / 48 h, 4,081 rows written). The function is on the do-not-deploy list until its gate secret is set, so a skip-poison-range guard would sit undeployed anyway.
5. ⛔ **`wallet-username-resolver` "stopped 08-30" is the deliberate dead-host pause** (cron-job.org entry disabled, cadence arm paused by `20260831030424`) — `public-api.nbatopshot.com` is decommissioned. The open work is a PORT, not a schedule; do not re-enable.
6. 📏 **`refresh_wmc_fmv_changed` (#36): a fresh T2 baseline was laid 2026-09-03 22:24Z** (`rwfc_cron_T2_20260903` / `rwfc_rest_T2_20260903` in `_rpc_waste_baseline_20260825`). **Read it as a FLOW ≥ 24 h out (from 2026-09-04 22:30Z), delta ÷ calls, on a quiet instance** — that is the first clean read of the 08-30 skip-unchanged change. The register's "STAYS until that decision is made" was stale: the fast path was reverted 08-27.
7. ✅ **Already done — do not carry forward:** the concierge distribution/quota item (mounts on insights/home/about/blog/early-access, `feature_quotas` free 5→40, `cache_control` in the route — all 09-02); the spork-wall counterparty backfill (floor + self-healing cursor `20260902042214`, recovering ~20k rows/day); the pack OG card + grails `buyableOnly` now share the 72 h EV freshness bar (code, 09-03).
8. ⏳ **Still owed (from the 09-03 CI-audit session's ledger entry):** R61's first clean `scheduler-liveness` read is the **09-04 ~12:5xZ** report (one day is one sample — read several); R86's positive half needs a real `PGRST002` window. Three `apply_migration`s ran 22:13–22:32Z on 09-03 with no sentinel run inside them (last sentinel 21:50Z) — no observation yet.
9. 🧭 **Accuracy-gate diagnosis, so it is not redone:** of Top Shot canonical editions at LOW with ≥5 sales/30d (**315**), median snapshot age is **2.6 h** — the recalc reaches them; 271 have ≥7 sales and are demoted by the dispersion gate (`MEDIUM_MAX_DISPERSION`), i.e. by design. There is no reach defect in the confidence pipeline; moving the headline is a policy or data-source question (Trevor).
10. ✅ **`sales-serial-backfill` Top Shot lane is ON-CHAIN (edge fn v38/v39, 09-03 late PT) — do NOT re-file the 3,071 `unknown` rows.** They were the decommissioned `public-api.nbatopshot.com` (CF 530/1033 + 429/1015). First tick 02:40Z: 131 → 128 resolved. v39 flips `ok=false` when a lane fails EVERY (≥20) target on transport; the pipeline now has a watchlist row (silent 360 / no-success 720). ⚠ Its `unknown` bucket newest `last_failed_at` must stay ≤ 2026-09-04 00:40:49Z — a later one is a NEW transport failure. ⚠ The daily edge-fn drift check (~11:39Z) must list `sales-serial-backfill` in parity (repo file == v39 body).
11. ⏳ **Sentinel "Pipeline Success" arm is LIVE and quiet** — first production run 02:20:54Z (`checks_run` 16, only the two pre-existing WARN arms). Its positive control is still owed: the first real `ok=false`-only stall it names. Three more Top Shot pipelines still call the dead host daily (`topshot-badge-set-backfill`, `topshot-catalog-backfill`, `topshot-misattrib-drain`) — filed 2026-09-04T0220Z as pause-or-port, a decision, not a chore; ~80 unwatched pipelines listed there too — ⛔ do NOT auto-seed 80 arms from the night pass.
12. 📏 **`pipeline_gap_hourly` is accumulating (pg_cron 443, `:07`, migration `20260904024810`) — a CALIBRATION SERIES, not an alarm.** Read it, do not act on it, until it holds weeks and at least one real correlated dip; the `_all_` row per hour carries scheduled/ticks/expected/skipped. ⚠ If `pipeline-gap-hourly-rollup` stops (watchlist: silent 180 / no-success 360, info), the series has a hole — re-run `rollup_pipeline_gaps(N)` with N covering the gap while `pipeline_runs` still retains it (≤ 73 h).
13. ✅ **Top Shot BASE circulation now comes from the chain daily** — `app/api/cron/topshot-circulation-onchain` (Vercel cron `5 4 * * *`, 04:05Z), `apply_topshot_onchain_circulation()` with the series-8 normaliser lifted into `topshot_normalize_circulation()` (migration `20260904031944`). ⚠ Base rows ONLY; parallels (`::`) stay with `backfill-topshot-subedition-circulation`. **The 2026-09-04 04:05Z tick FAILED HONESTLY (`ok=false`, 38/39 script calls HTTP 400 = Flow error 1110, computation limit at 250 pairs/script); chunk is 40 since `7df740cae`. First real read owed: the 2026-09-05 04:05Z tick** — `pipeline_runs` `ok=true`, `extra.pairs_read ≈ 9,5xx`, `script_errors 0`, `changed` small. ⛔ Do NOT re-file `topshot-catalog-backfill`'s daily 530 as a circulation gap — the circulation half is ported; tier/media/new-edition creation are the Atlas decision (inbox 2026-09-04T0220Z §1).


## STEER — added 2026-08-28 ⚠ READ BEFORE QUOTING THE ACCURACY GATE

🚨 **The gate has TWO instruments and they disagree by 9.4 points. Priority 1's 30.1% and the trust
board's `*_fmv_high_med_share_pct` are NOT the same measurement**, and comparing one to the other
overstates progress by ~4×.

- **Priority 1's 30.1% baseline (08-23)** came from `fmv_current` with **no Top Shot filter**.
- **The trust board / `rpc_fmv_confidence_share()`** filters Top Shot to **canonical `external_id`**
  (`^[0-9]+:[0-9]+(::[0-9]+)?$`), excluding UUID dupe residue — deliberate, shipped 2026-08-04, but the
  baseline was never re-based onto it.

**Measured both ways on 2026-08-28 so the comparison is like-for-like:**

| | 08-23 baseline | today, SAME method | today, canonical-filtered |
|---|---:|---:|---:|
| priced editions | 27,075 | **27,143** | 20,717 |
| HIGH/MEDIUM | 8,140 | **8,950** | 8,787 |
| share | **30.1%** | **33.0%** | **42.4%** |

⭐ **The real five-day move is +2.9 points (30.1% → 33.0%), and it is GENUINE** — the denominator is
stable (27,075 → 27,143, +68), so it is 810 more editions reaching HIGH/MEDIUM rather than weak ones
leaving. Top Shot 34.3% → 37.5%.
⛔ **Do NOT quote 54.4% against 34.3%, or 42.4% against 30.1%.** Those are cross-instrument comparisons.

👉 **DECISION NEEDED (not a measurement): pick ONE basis and re-base the baseline explicitly.** The
canonical-filtered figure is arguably more honest — pricing dupe residue is not an accuracy achievement
— but switching silently books a **+9.4 point one-off no edition earned**, against a 50+ WAU gate whose
history is all on the unfiltered basis.

⚠ **Pinnacle is a THIRD basis and is in neither total** (`rpc_fmv_confidence_share()` returns five
collections, Pinnacle not among them; its 44% comes from a separate leg). **Both totals cover four of
five published collections**, exactly as the 08-23 capture warned. Full working:
ledger 2026-08-28 "the accuracy gate has TWO instruments".

## PRIORITIES — what tonight's pass should weigh

1. ✅ **CAPTURED 2026-08-23 22:05Z — the four-week gap is closed, so do not re-ask for it; re-MEASURE it.** **21 accounts** (was 20 on 07-26, so **+1 in four weeks**), **0 signups in 7 d** (newest 2026-08-08), **signed-in WAU = 0**, MAU = 2. Roadmap gate is 50+ WAU. ⛔ **Do NOT read `funnel_events` sessions as users — that instrument is wrong by ~3 orders of magnitude**: 16,463 weekly "non-bot" sessions of which **99.67% fire exactly one event and never return**, 4 `wallet_paste` sessions, 0 `signin_click`, 0 `account_created`. ⚠ **Vercel Web Analytics is NOT enabled**, so `funnel_events` is the only traffic instrument and has no independent corroborator. ⚠ **`bot_ua` is only meaningful from 2026-08-23 02:00Z forward** — before that the column exists with no UA to classify, so `false` means "never saw one", not "human". Full capture, with the accuracy gate alongside it: [inbox 2026-08-23T2205Z](inbox/2026-08-23T2205Z-priority-1-captured-wau-is-zero-and-the-accuracy-gate-is-30-percent.md). **Demand is still the gate that matters and the roadmap's answer to a 0 is ACCURACY FIRST, not growth tactics.** ⭐ **And the accuracy gate is measured too, for the first time: 30.1% HIGH/MEDIUM** (Top Shot 34.3%, All Day 21.4%, Golazos 0.0%, UFC 0.0%, Candy 61.6%) — ⚠ **excluding Pinnacle, which has ZERO rows in `fmv_current`** and prices through its own triple-keyed path, so the headline covers four of five published collections. ⛔ **Do NOT chase Golazos' 0%** — measured, every edition that sold there has **1–3 sales a month (avg 1.4)**, so a threshold change would manufacture confidence, not accuracy. ⭐ **The gate is mostly a LIQUIDITY CEILING, not an engineering defect:** on All Day, confidence tracks volume monotonically — HIGH averages 11.8 sales/30d and **100% have ≥5**, MEDIUM 5.5, LOW 2.6. 🚨 **THAT QUESTION IS ANSWERED AND IT IS BIGGER THAN IT LOOKED: ~1,000 editions estate-wide are labelled LOW while their own `sales_count_30d` is ≥5, and in EVERY collection the LOW cohort trades ~2× the MEDIUM cohort** (Top Shot 499 editions at avg 28.9 vs MEDIUM 15.2 vs HIGH 14.0; All Day 454 at 15.6 vs 9.3 vs 9.4; Candy 44 at 48.1). Controls rule out staleness (145/150 computed in 24 h), legacy algo (137/150 are `1.7.0`, same as MEDIUM) and my own query (the figure is the pipeline's own column). `computeConfidence` makes LOW the floor case, so the rule says this cannot happen. **Two readings, both defects:** the LABEL is wrong (~+2 points on the gate, and we publish our lowest confidence on the editions users look up most), or the COLUMN is wrong (`sales_count_30d` may hold the 90-day widened count — it reads 12.7 where a raw 30 d count reads 7.6). ⭐ **RESOLVED the same evening — and it is a CALIBRATION question, not a bug.** Re-measured from `sales` directly (never the column): **368 Top Shot editions publish LOW on a TRUE 39.6 sales/30 d average vs MEDIUM's 22.2**, all 352 current-algo ones computed within 24 h, `days_since_sale` 4.7, true counts 5 → **643**. The cohort is **sub-$2.50 WNBA Series 8 moments at 5/5 liquidity** — a **$0.49** FMV built from **643 trades** publishes as LOW. The demotion is **BY DESIGN**: `MEDIUM_MAX_DISPERSION = 0.35` demotes MEDIUM→LOW once count ≥7, so only high-volume editions are even eligible. ✅ **The dispersion measurement RAN in a quiet window (2 active / 1 IO waiter) and settles it: LOW avg CV **0.731** with 76% over the 0.35 ceiling, HIGH avg CV **0.222** with 10% over.** The mechanism is confirmed. 🚨 **But my sub-dollar-tick calibration story is FALSIFIED by its own prediction** — it predicts HIGH skews expensive; measured, **HIGH has the LOWEST median price ($0.31) and the MOST sub-dollar editions (72%)**, while LOW's median is $1.08. Price level does not drive the demotion. ⛔ **The "build a tick-aware dispersion measure" recommendation is WITHDRAWN — do not act on it.** ✅ **The system is behaving correctly**: 643 trades with a CV of 0.73 genuinely is an uncertain price. ⭐ **What survives is one user-facing observation: `LOW` is doing two opposite jobs** — *"we have almost no data"* and *"we have 643 sales and they disagree"*. To a collector those are opposite messages, and merging them into one badge is the honesty canon's three-states problem applied to a LABEL. Splitting it is a product decision (a new enum touches every surface, the OG cards and the concierge) — **the measurement is filed so the call can be made on it.** Filing: [inbox 2026-08-24T0225Z](inbox/2026-08-24T0225Z-a-thousand-editions-are-labelled-LOW-while-they-are-the-most-traded-on-the-platform.md).
2. **Prefer DB/artifact work that does not need a push.** Cloud-sandbox passes have repeatedly been NO-PUSH. Work that lands as a migration or an artifact ships; work that needs a git push may not. (⚠ Push from Trevor's **local** box is fine — verified 2026-08-17 — so a NO-PUSH night is a *sandbox* limitation, not a repo one.)
3. **Do not open new investigations into disk-IO saturation symptoms.** The fmv-recalc kill rate, `public_board_slow_count`, the board-warm failures, the pg_cron statement-timeouts and the `get_collection_stats` timeout are **one root cause** (disk-IO budget on the SMALL 2 GB instance). The lever is cutting work — page size, precompute, fan-out — **never** raising a timeout and never upgrading the tier.

## STEER — added 2026-08-27 (memory-refresh pass: CLAUDE.md, the register, the roadmap, the trust board and the schema stamp re-derived against live sources)

1. 🚨 **THE ONE THING THAT WILL WASTE A PASS IF UNREAD: the daytime monitor's 08-28T0310Z filing asks you to
   "check whether the next scheduled run (08-28 22:10Z) lands" — THAT TICK WILL NEVER FIRE.** The night pass
   moved `candy-editions-ingest` `10 22 * * *` → `10 1 * * *` in the same window (`544f3e6c0`, deploy READY
   2026-08-28 03:11Z), and because the deploy landed AFTER 01:10Z that day, **the first run at the new slot is
   2026-08-29 01:10Z**. Against a last success of 08-26 22:10Z that is **~51 h of silence on a 30 h arm**, so
   ⛔ **the `cron_silent` BREACH you will see is the transition plus the 08-27 kill, not a new fault** — do not
   re-diagnose it, do not raise `max_silent_minutes`, do not suppress the arm. ✅ **The live watchlist note has
   been corrected in place** (it still said "10 22" and carried the unexecutable verify step) — record:
   `supabase/migrations/20260828040000_audit_20260827_correct_candy_editions_watchlist_note.sql`. **FALSIFIER,
   and the only thing worth acting on: if 08-29 01:10Z and the ticks after it keep missing at ~45%, the HOUR is
   not the cause — it is D8's wmc row-lock contention, and the durable fix is the `paginateGroup` chunking
   (handoff 2026-08-04, Item 2, unshipped).** Register: **#47** (new).
   ⭐ **Two sessions characterised this pipeline within five minutes of each other and reached compatible
   conclusions from different instruments — but the FILING went stale before it was read.** When you file an
   action item that names a clock time, name the schedule it depends on too.
2. ⏳ **Pack-pool wedge fix (`20260828025307`): first post-fix reading is 6 ok / 4 failed over 10 ticks
   (40.0%) against 131 consecutive failures before it, backlog 368 → 360, dists with pool rows 1,715 → 1,736.**
   The ledger's prediction was *"settles near 33%, NOT 0%"* — 40% on n = 10 is inside that. ⛔ **Do NOT close
   it on this**: the exit condition is a conversion rate over ~100+ ticks, and ⚠ **the 2-day rollup still reads
   74.1% failed because it is dominated by the pre-fix window — that number is not the current rate.**
3. ✅ **Re-verified live, so do not re-derive these before ~08-29 unless you are acting on them:** headline
   metric (every collection INSIDE its own 5-sample range; **the "Candy is moving monotonically" claim broke at
   the fifth sample — 64.0 → 63.2 — and neither the run nor its break is a trend**) · demand (**23 / 2 / WAU 2
   / MAU 4, identical to 08-26 — a confirmation, not a new number**) · the all-keys accuracy denominator
   (**30.1% → 33.4%**) · #22 the defeated purge (unchanged, 25 days, third instrument) · #8 the sports proxy
   (**0 ok / 16 in 48 h**) · #34 Sentry (**newest stored event STILL 2026-08-18T13:21:59Z — the "a quota resets,
   it will heal itself" hypothesis predicts a resumption that has not happened in 9 days**) ·
   `compute_pack_ev_per_edition_weighted` (fix still unshipped in live `prosrc`).
4. ⚠ **Trust board is 3 breached, up from 2 on 08-26 — diff the SET: the new arm is `board_mv_refresh_stale_hours`
   (9.57 vs 8), the one the 08-26 entry recorded as "all clear".** ⛔ It is the documented cadence-vs-threshold
   mismatch (a 6-hourly refresher against an 8 h threshold has 2 h of headroom), not a new incident.
   `unmapped_resolution_backlog_max` is the one arm still climbing (258 → 291 → **338**).
5. ⭐ **A durable lesson was promoted to CLAUDE.md this pass and is worth applying beyond the job it came from:
   a killed `after()` run is ABSENT from `pipeline_runs_daily` rather than counted as a failure, so that rollup
   reads `runs 1 · ok 1 · failed 0` for every recorded day while a job dies nightly.** The **47 still
   un-heartbeated `after()` routes cannot be audited at all** by either rollup — that is the argument for
   continuing the E5 conversions, and it is a measurement, not a preference. ✅ **And the correlation is no longer a hand-derivation: `npm run pipelines:kills` (`lib/pipeline/kill-rate.ts`, shipped the same night) does it with the recency test built in — use it, and split any candy-editions rate at the 08-28 03:11Z deploy from 08-29 onward.**

## STEER — added 2026-08-26 (memory-refresh pass: CLAUDE.md, the register, the roadmap and the schema stamp re-derived against live sources)

1. ✅ **FIXED THE SAME DAY (2026-08-26) — `/insights/underpriced-serials`'s React #418, plus the guard gap that let it through. ⏳ The one thing left is VERIFICATION: watch `E2E DOM Smoke` across SEVERAL scheduled runs, because the failure is intermittent and one green run proves nothing.** Detail + the mutation checks: known-issues #37. ⛔ Do not re-open the diagnosis from the ingest cadence — that hypothesis was checked and found insufficient; the cause is that the CACHED HTML can be hours old (measured 2.5 h), not that the spine is stale. **Original filing, kept because it is what a next session should recognise:** 🚨 **it was throwing in PRODUCTION and nothing but a scheduled badge could see it.** Two consecutive `E2E DOM Smoke` runs (08-26 13:37Z and 21:09Z), all retries, 1 failed / 95 passed. **This is the highest-value shippable item on the board right now**: it is user-facing, the mechanism is identified in code (`UnderpricedSerialsBoardClient.tsx:341` computes `listingsAgeHours` from `Date.now()` during render, rendered at :391, on a `revalidate = 900` ISR page — so server HTML and hydration disagree whenever the rounded hour ticks over), and the fix is local. ⛔ **Do NOT reach for `suppressHydrationWarning`** — that silences the only instrument. Compute the age in an effect after mount, or pass a server-stamped age as a prop.
2. ⚠ **Priority 1's demand numbers below are SUPERSEDED — re-read 2026-08-26: 23 accounts (+2 in 7 d, newest 08-25), WAU 2, MAU 4.** The "0 signups in 7 d / WAU = 0" line is no longer true. **n = 2 is not a trend and does not move the 50+ WAU gate**, but do not re-publish the zero.
3. ⭐ **The register was swept 08-26 and SEVEN items moved** (#8, #27, #29, #30, #34, #35, #36) with two new ones (#37, #38). **Read the sweep stamp at the top of `### Open` before re-deriving anything** — an item the stamp does not name still carries its own older date.
4. 🟡 **#38 is the new "filed but never registered" case: `topshot-pack-pool-backfill` is 1 ok / 273 failed per day** and has been since at least 08-25, sitting in the inbox. Most of it is a correct report of an empty queue — **but 15 statement timeouts are hiding inside the 258-strong signature**, and a permanently-red pipeline is a permanently-unread one. Do not suppress the arm.
5. ⏳ **Do NOT re-litigate the `refresh_wmc_fmv_changed` fast path before its scheduled read.** Correctness is proven; the cost claim is not, and the A/B is confounded. The clean baseline rows (`rwfc_*_T1_CLEAN_20260827` in `public._rpc_waste_baseline_20260825`) must be re-read **in a quiet window ≥24 h after 2026-08-27 02:05Z**. Reverting or re-measuring earlier repeats the mistake in the other direction.

## STEER — added 2026-08-24 (memory-refresh pass: CLAUDE.md + the reference set re-derived against live sources)

- 🚨 **A NEW MEMBER OF THE HONESTY CANON, AND IT IS A CACHING ONE: ISR bakes a failed read into the whole
  `revalidate` window.** A COLD regeneration that exceeds the 8 s `BOARD_LIVE_TIMEOUT_MS` fails the page's
  read, and `revalidate = 900` then serves that failure for **up to 15 minutes** — observed live on
  `/insights/pack-drops` at `x-vercel-cache: HIT`, `age: 158`, while the API itself answered in **1.2 s**.
  ⚠ **It self-heals on the first warm pass, so it is easy to declare fixed by accident** — the honest test
  is *"does a COLD regeneration still exceed the budget"*, never *"is the page OK now"*. ⛔ **Do NOT raise
  `BOARD_LIVE_TIMEOUT_MS`** (shared by every board), **do NOT retry** (the abandoned query keeps running
  server-side), **do NOT lower `revalidate`** (that hits the cold path MORE). The two real options — a
  per-caller budget, or a genuine stale snapshot — are **Trevor's call**. Full write-up:
  [key-files-and-honesty.md](../reference/key-files-and-honesty.md); filing:
  [inbox 2026-08-24T1441Z](inbox/2026-08-24T1441Z-a-cold-isr-regeneration-can-bake-a-failed-read-into-15-minutes-of-cached-html.md).
- ⛔ **`metrics-latest.json`'s `inbox_archiving_note` was REFUTED and has been corrected in place.** It told
  a push-capable pass to archive resolved inbox filings and framed ~200 un-archived files as *"the accrued
  cost of the NO-PUSH streak"*. Both halves are wrong — see the DO-NOT-ARCHIVE section below, which was
  already in this file and was not read. **This is the shape CLAUDE.md flags as least re-checked: a filed
  DECISION, and specifically a queued CLEANUP, because housekeeping reads as obviously safe.**
- ✅ **#22 (the defeated credential purge) re-verified 2026-08-24 and it is STILL LIVE.**
  `refs/heads/claude/todo-implementation-e4tib3` is still on origin at `ee94c8a2a`; the values-free control
  re-ran **e4tib3 2 · main 0 · qi4350 0**, so the exposure is still exactly one branch. ⚠ **`git cat-file -e
  <blob>` is NOT a per-branch test** — after fetching either branch it answers `yes` for both. Operator-only,
  unchanged: triage → delete via the GitHub UI → ask Support to GC → **rotate regardless**.
- ⚠ **CLAUDE.md no longer carries the collection UUIDs in prose** — they were displaced 2026-08-24 to pay for
  the ISR rule above, and [schema-truth.md](../reference/schema-truth.md) is now the **only in-repo copy**
  (all 7 re-verified against live `public.collections` that day, zero drift). **A stale stamp on that section
  is now a silent failure, not a redundant one** — re-verify it whenever you touch it.
- **Re-derived the same day, so do not re-quote the older figures:** repo map `lib/` **301 → 308** and
  `scripts/` **97 → 103** (everything else held); and **both "measured-but-unshipped DB fixes" are still
  unshipped**, confirmed from live `prosrc` rather than re-read from the filings — `drain_fmv_cold_tail`
  still opens on the unscoped `GROUP BY edition_id` over `fmv_snapshots`, and
  `compute_pack_ev_per_edition_weighted` still carries its `fmv_current` leg.

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

**The convention and the citation practice are in conflict, and the citations win.** Treat `inbox/` as append-only. If the directory's size becomes a real problem, the fix is a redirect/stub or an index — not a `git mv`. ⚠ **THIS IS ENFORCED: `__tests__/inbox-is-append-only-since-the-rule.test.ts` bans any filing dated on or after the rule from sitting in `archive/`.** ⛔ **And the 2026-08-24 night-pass handoff queued the OPPOSITE** — *"a push-capable pass should archive resolved items"*, calling ~200 live filings *"the accrued cost of the long NO-PUSH streak"*. **They are not debt; they are the intended steady state.** A push-capable pass tried it on 2026-08-24 and the guard stopped it. **Retire a filing by annotating it in place with a ✅ RESOLVED section — never by moving it.**

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
