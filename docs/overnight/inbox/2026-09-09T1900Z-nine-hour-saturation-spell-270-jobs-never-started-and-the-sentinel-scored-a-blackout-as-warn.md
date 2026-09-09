# A nine-hour instance-wide saturation spell is in progress, 270+ pg_cron jobs never STARTED, and the sentinel reported it correctly as WARN — which is a green badge

*Claude Code (cloud), 2026-09-09 ~12:0x PT / 19:0xZ · found while asking what the CONTROL meant. LIVE AND WORSENING at time of writing.*

## How this was found, because the method is the transferable part

Earlier today I used "the whole fleet got slower" as a **no-change control** to exonerate a
deploy of mine. The control did its job — my change was innocent. ⭐ **Then I never asked what
the control itself meant.** A signal strong enough to exonerate a change is strong enough to be
a finding, and it sat unexamined for three hours because it had already been *useful*.

## What is happening (all measured 2026-09-09, UTC)

**Fleet median pipeline duration by hour** — 09-07 and 09-08 are FLAT at the same hours, so this
is NOT the chronic daytime IO band:

| hour | 09-07 | 09-08 | 09-09 |
|---|---|---|---|
| 08 | 1,266 | 2,649 | 2,988 |
| 10 | 1,764 | 2,540 | **10,970** |
| 13 | 2,886 | 3,505 | **20,620** |
| 18 | 3,101 | 3,316 | **30,921** |

A step at **10:00Z**, sustained ~9h, still climbing. Run counts fall in the same hours (142 at
18Z vs ~270 normal), so work is also completing less.

**Every lane is 6-32x slower** (10-18Z, today vs yesterday): `refresh_wmc_fmv_changed` 265ms ->
8,597ms (32.5x), `alerts-dispatch` 11.5x, `atlas-editions-refresh` 10.6x, `lock-check-batch`
37.9s -> 240.6s. Unrelated subsystems moving together = an instance-wide IO constraint, so
**ratios cannot separate initiator from victim** and no cause is claimed from them.

🚨 **THE PART THAT IS NOT JUST SLOWNESS: `max_worker_processes = 6`.** pg_cron launches each job
as a background worker. The six-hourly heavy MV refreshes are clustered at minutes 20/23/35/47/48/50
of hours 0/6/12/18; at yesterday's runtimes (12-93s) they finished before each other, at today's
(250-600s) they **overlap and exhaust the 6 slots**. Caught in the act at 18:54Z: three of them
running simultaneously at 438s, 377s and 257s. Everything else then fails to launch:

**270+ `job startup timeout` failures since 10:00Z**, bursting at hours 12 (10), 13 (66) and 18 (59)
— exactly the `*/6` collision hours. `rpc-ts-listings-atlas-sync` alone: **153**.

⛔ **AND THAT FAILURE MODE WRITES NO `pipeline_runs` ROW**, because the job body never runs, so
`log_pipeline_run` is never reached. This is the same shape CLAUDE.md recorded yesterday for the
REVOKE/grant case, with a different cause: *for any "scheduled job wrote no row", the discriminator
is `cron.job_run_details`, never the pipeline table.*

**Measured damage:** `ts-listings-atlas-sync` ran **113 times vs 268** yesterday (-58%, matching its
153 startup timeouts). Atlas event ingest **91,567 rows vs 169,090** in the same window yesterday
(-46%). ⚠ Stated precisely: the feed is CURRENT right now (newest row 2.5 min old), so the loss is
listings/sales that existed only inside a missed window, not a persistent gap — bounded, not zero.

## The instrument finding, which outlives this incident

The 18:47Z sentinel sweep — taken DURING the worst hour — reported:
- `Pipeline Silence`: **warn**, "ts-listings-atlas-sync silent 54m (>20m, medium)"
- `Pipeline Success`: **warn**, same lane
- and **six of sixteen checks INCONCLUSIVE (db saturated)**, including **`Trust Health`**, the master arm.

**Overall: `WARN`. GHA: green.**

🚨 **SELF-CORRECTION, MADE BEFORE SHIPPING AND IT SHARPENS THE FINDING RATHER THAN SOFTENING IT.** An earlier draft of this said the estate went unnotified, citing `ops_alert_dedup` empty for fourteen hours. **That was an over-claim and it is wrong.** The 18:47Z report carries `notifications: ["telegram", …]`, and the route's own helper returns a channel name **only when it actually accepted the message**, so a Telegram alert WAS delivered during the incident. (`ops_alert_dedup` belongs to a different alert path; its emptiness says nothing about the sentinel.)
⭐⭐ **The truth is worse than the over-claim, which is why it is worth getting right.** `shouldNotify = hasCritical || hasWarn || isScheduledReport` — **every WARN notifies.** And on this same sweep at least two arms carry chronic warns: `Detector Health` (explicitly ACKNOWLEDGED until 2026-10-03, on a 12-run streak) and `Dune Spend` (a cycle metric at 103.5 % with 15 days left). So overall status is WARN on a quiet day too, and **the nine-hour incident produced a Telegram message indistinguishable from the one a healthy afternoon produces.** ⚠ Stated as an inference from those two arms, not as a measured rate — the report is persisted nowhere, so no history of overall status exists to count. **The alert was not missing; it was uninformative.** That is exactly the failure the sentinel route names twice in its own comments — a permanently-warn arm desensitises every other arm — occurring at the REPORT level rather than the arm level.
⭐ **And it repoints this arm's value:** the fix is not escalation (the blackout arm still cannot page). It is that the report now carries a **number** — `N of M checks could not be evaluated` — which is the only thing in the payload that distinguishes today's WARN from yesterday's.

⭐ **Nothing here is broken and nothing lied.** The per-check rule — degrade a statement timeout to
`warn`, never page — is CORRECT and was earned by two documented false CRITICAL pages (2026-06-10,
2026-07-16) where a timeout was reported as data loss while sales flowed normally. ⛔ Do not undo it.

**The gap is one level up.** `route.ts:1565` computes overall status with
`checks.some(c => c.status === "warn")` — a **`some()`, not a count** — so ONE warn and THIRTEEN
warns are the identical `WARN`, and the GHA gate fails only on `CRITICAL`. ⭐⭐ **Each check reasons
correctly in isolation and no check can see the population. "My query timed out, that is not data
loss" is right. "Six of us timed out at once" is a much stronger statement, and nothing in the
system could make it.**

✅ **SHIPPED: `lib/sentinel/blind-checks.ts` + a `Measurement Blackout` arm.** It issues **no query**,
so it is the one arm that gets *more* informative as the database gets worse. Capped at `warn`, never
`critical` (escalating a blackout is the 2026-06-10 mistake one level up), and `ok`-but-**visible**
below threshold per the route's own anti-chronic-warn convention.

🚨 **AND IT WAS WRONG BEFORE IT SHIPPED — caught by replaying the REAL sweep instead of a fixture.**
Keyed on the `INCONCLUSIVE` label it counted **FOUR**, under its own threshold, and would have stayed
silent on the incident that motivated it. Two checks time out with the identical saturation error and
are never labelled, because they build their detail by hand:
`FMV Confidence (canonical TS)` and `Edition Coverage`. ⭐ So the arm keys on the **condition**
(the saturation signature) not the **label** — the two unlabelled checks are not an oversight to go
fix and forget, they are proof the label will drift again. The real 18:47Z payload is now a test
fixture, verbatim, and label-only detection fails it with "expected 4 to be 6".

**Threshold, and it is honestly weak:** the report is not persisted anywhere, so there is NO
distribution to fit to. Anchored on the only two points that exist — 4 inconclusive judged noise
(2026-06-10), 6 during a real incident (today) — as `ceil(evaluated/3)` floor 5, giving 6 on 16
checks. **The arm prints its count on EVERY run including at `ok`, so the distribution it should
have been fitted to starts accumulating now.** Re-derive before trusting the 6.

## Root cause: NOT SETTLED, and candidates are labelled as such

- ⛔ **Autovacuum — REFUTED as the driver.** A 48-minute `VACUUM ANALYZE wallet_moments_cache` was
  running at first look; it finished and the instance stayed at 12 active / 11 IO waiters. A symptom
  or contributor, not the cause.
- ⛔ **Invalid index — REFUTED.** Zero invalid/not-ready indexes in `public`.
- ⛔ **FMV propagation wave — REFUTED as sufficient.** Writes did step up at 10Z (~400 -> ~2,000/hr),
  but **09-08 20-23Z hit 3,000-3,466/hr with only a mild rise**, so volume alone does not produce this.
- ⚠ **`wallet_moments_cache` is the common denominator and is UNPROVEN:** 2.3M rows / 3,156 MB,
  `autovacuum_count` 963 (vs 5 on `moments`), `n_mod_since_analyze` 106,504 one minute after a vacuum
  completed, and four of the slowest jobs are wmc writers. ⚠ The 963 has **no window** —
  `pg_stat_database.stats_reset` is NULL — so it is not a rate and must not be quoted as one.
- ⚠ **The `*/6` clustering is a CASCADE AMPLIFIER, not the origin.** It converts a slowdown into
  total launch failure. ⛔ Do NOT "fix" by staggering on this filing alone — CLAUDE.md already records
  a stagger that was REFUTED, and treating the amplifier while the origin is unknown is how the
  jobid-481 mistake happens in reverse.

## What is NOT done, and why

⛔ **Nothing operational was changed.** The origin is unknown, capacity is Trevor's call
(CLAUDE.md: no infra spend pre-revenue), and every lever available from here — unscheduling a heavy
job, staggering the `*/6` block — treats a symptom on an unproven mechanism. The one change shipped
is the instrument, which is safe and makes the NEXT one legible.

**Live state at 19:0xZ:** 13 active / 13 IO waiters, 46 startup timeouts in the last hour, 30-minute
median 27,048 ms, `ts-listings-atlas-sync` silent **71 minutes** against a 20-minute arm.
