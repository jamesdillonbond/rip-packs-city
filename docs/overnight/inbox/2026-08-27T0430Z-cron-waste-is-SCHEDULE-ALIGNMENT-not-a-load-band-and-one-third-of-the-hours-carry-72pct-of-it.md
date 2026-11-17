# ⭐ 22.6% of this instance's cron time is thrown away — and it is **schedule ALIGNMENT**, not a load band, not a slow job

**Filed 2026-08-26 (PT) / 2026-08-27 04:30Z by Claude (Cowork cloud). NOTHING SHIPPED.**
**A triage instrument, a fleet-wide measurement, and one worked example whose evidence is
within-subject and therefore actually controlled.**

---

## 1. The headline, and the number that has not moved

Over **7 days**, `cron.job_run_details`:

| | |
|---|---:|
| runs | **28,509** |
| busy seconds | **914,843** |
| failures | 1,502 |
| **wasted seconds** (busy time in failed runs) | **206,362 — 22.6%** |
| failures that are `canceling statement due to statement timeout` | **384 of 1,502 (25.6%)** |
| **waste those 384 account for** | **175,882 s — 85.2% of ALL waste** |

🚨 **22.6% is exactly the figure the earlier Class-A audit recorded over 48 h** (*"7,230 runs, 64
failed, 76,768 busy-seconds, 17,382 wasted → 22.6%"*). ⭐ **That audit identified
`rpc-refresh-perfect-mint-premiums` as "the lever" at 27.8% of all waste. The lever was pulled — it
is now 1,809 s of 206,362, i.e. 0.9% — and the total waste ratio is unchanged.**

⚠ **Two points do not make a law, and the windows differ (48 h vs 7 d).** But it is the right thing
to be suspicious about, and §3 gives a mechanism that predicts it: **if waste is a property of the
CONTENTION rather than of any one job, removing the biggest job redistributes it instead of reducing
it.** Whichever job happens to be running when the instance saturates is the one that burns its
ceiling.

## 2. ⭐ A triage instrument: `max(success duration) ÷ that job's own timeout ceiling`

A job that times out tells you nothing on its own. **This ratio splits a fleet of them into three
classes in one query, and the classes have different remedies.** Top offenders, 7 days:

| jobid | job | owner | to-fails | max OK | ceiling | **ratio** | wasted 7 d |
|---:|---|---|---:|---:|---:|---:|---:|
| 71 | `rpc-backfill-historical-pack-ev` | cron_heavy | 40 | 578 s | 600 | **96%** | **24,096 s** |
| 217 | `rpc-atlas-pack-ev` | cron_heavy | 37 | 595 s | 600 | **99%** | **22,360 s** |
| 73 | `rpc-refresh-mv-pack-ev-latest` | cron_heavy | 25 | 589 s | 600 | **98%** | 15,114 s |
| 211 | `rpc-refresh-allday-pack-realized` | cron_heavy | 19 | **92 s** | 600 | **15%** | 11,401 s |
| 215 | `rpc-allday-nem-from-sales-backfill` | cron_heavy | 11 | **731 s** | 600 | **122%** | 8,005 s |
| 65 | `rpc-allday-ev-corrected-refresh` | cron_heavy | 12 | 593 s | 600 | 99% | 7,292 s |
| 210 | `rpc-refresh-allday-pack-sales-agg` | cron_heavy | 9 | **771 s** | 602 | **128%** | 6,675 s |
| 212 | `rpc-refresh-topshot-pack-sales-agg` | cron_heavy | 9 | 570 s | 600 | 95% | 5,404 s |
| 235 | `rpc-refresh-market-index-daily` | postgres | 9 | 565 s | 600 | 94% | 5,403 s |
| 261 | `rpc-refresh-unmapped-backlog-growth` | postgres | 36 | 120 s | 120 | **100%** | 5,337 s |
| 218 | `rpc-backfill-pinnacle-mint-acquisitions` | cron_heavy | 8 | 364 s | 600 | 61% | 5,068 s |
| 259 | `rpc-reconcile-saved-wallet-stats` | postgres | 31 | 118 s | 120 | 99% | 3,852 s |
| 302 | `rpc-backfill-wmc-fmv-confidence` | postgres | 29 | **124 s** | 120 | **104%** | 3,778 s |
| 256 | `rpc-thin-sale-ask-disclosure-refresh` | cron_heavy | 5 | **never** | 600 | **n/a** | 3,000 s |
| 4 | `rpc-ccm-step2` | postgres | 6 | **10 s** | 300 | **3%** | 1,801 s |

- **Class A — CLIPPED TAIL (ratio ≥ 90%).** The job succeeds right up against its wall; the failures
  are the same distribution's right tail. **More headroom finishes most of them.** 71, 217, 73, 65,
  212, 235, 261, 259.
- **Class B — ALREADY EXCEEDS ITS CEILING (ratio > 100%).** 🚨 **A job that has SUCCEEDED at 771 s is
  being killed at 602 s.** The ceiling is not constant across its runs — different call paths set
  different `statement_timeout`s, or the `SET` is not always applied. **That is a correctness
  question about the schedule, not a capacity one.** 215, 210, 302, 75, 236.
- **Class C — THE FAILURES ARE A DIFFERENT POPULATION (ratio ≪ 90%).** ⛔ **Headroom will not help
  these.** `rpc-ccm-step2` succeeds in **10 s** and fails at **300 s**; `refresh_allday_pack_realized`
  succeeds in **32–106 s** and fails at **600 s**. **A clean bimodal split at exactly the ceiling is
  the signature of BLOCKING or STARVATION, not of slowness.** 211, 4, 218, 237, 288, 60, 325.
- ⛔ **And one job has NEVER succeeded:** `rpc-thin-sale-ask-disclosure-refresh` (jobid 256) — **7
  runs, 5 statement timeouts, zero successes in the retained window**, burning 600 s daily. It is not
  in any register.

## 3. ⭐⭐ The mechanism: hours divisible by 3 are where the heavy cohort collides

Run counts are almost flat across the day (**1,120–1,313 per hour**), but the timeout rate swings
**0.0 → 51.0 per 1,000 runs**. It is **not** a daytime band — hour 12 is 51.0 while hour 14 is 5.1
and hour 11 is 2.7; hour 0 (16.0) is higher than hour 11. **It is arithmetic:**

| | hours ÷ 3 | other hours |
|---|---:|---:|
| hours | **8** | 16 |
| runs | 9,880 | 18,629 |
| **busy seconds** | **430,173 (47%)** | 484,670 |
| timeout failures | **248** | 136 |
| **per 1,000 runs** | **25.1** | **7.3** |
| wasted seconds | **126,092 (72%)** | 49,791 |
| **share of that bucket's busy time wasted** | **29.3%** | **10.3%** |

⭐ **One third of the hours carry 47% of all cron work and 72% of all timeout waste, and 29.3% of the
work done in them is thrown away against 10.3% elsewhere — 2.8×.** The cause is that `*/2`, `*/3`,
`*/6` and daily schedules all land on multiples of 3 and 6; **hour 12 is where every cycle
coincides, and it is the worst hour by a factor of ten.**

⚠ **I cannot separate "more heavy work is SCHEDULED then" from "that work starves itself".** The
busy-seconds row shows both are true — the cohort really is aligned there. **But both readings point
at the same remedy**, so the finding is robust to the ambiguity even though the causal share is not
measured.

## 4. ✅ The controlled evidence — one job, four slots, same work

Everything above is between-jobs and therefore confounded. **Jobid 211 is not.** Same function, same
MV, four slots a day, full retained history since 2026-07-20:

| slot | runs | ok | failed | **ok rate** |
|---|---:|---:|---:|---:|
| **00:35Z** | 37 | 36 | 1 | **97%** |
| 06:35Z | 37 | 19 | 18 | 51% |
| 12:35Z | 37 | 20 | 17 | 54% |
| 18:35Z | 38 | 16 | 22 | **42%** |

**Successes take 32–106 s. Failures burn exactly 600 s.** The job is cheap when it runs at all.
⭐ **The hour decides the outcome, not the job.**

⛔ **And the obvious competing explanation is falsified without a query.** *"The 00:35 run succeeds
because its delta is small"* cannot hold: `REFRESH … CONCURRENTLY` costs what changed since the last
refresh, and **00:35 is the slot with the LARGEST typical delta** — the 18:35 run usually fails, so
00:35 is folding in 12 h of sales rather than 6. **The most reliable slot is the one with the most
work to do.** That inverts the hypothesis.

⚠ **And the recent window is worse than the long run:** 19 of 26 failures in 7 days (73%) against 58
of 149 all-time (39%). **Some of that is the saturation spell I contributed to this week** — index
builds, 900k-buffer `EXPLAIN`s — so do not read the 7-day rate as the steady state. **I nearly
reported "0 of 19, so the other three slots never work"; the full history says they work about half
the time, and checking that is the only reason this filing is not wrong.**

## 5. 👉 What to do, and why I shipped none of it

⛔ **The obvious move — stagger the heavy cohort off multiples of 3 — is exactly the shape of a
proposal this repo has already REFUTED**, and its refutation is the rule to obey here:
[`2026-08-16T1520Z`](2026-08-16T1520Z-the-13-stagger-is-REFUTED-do-not-run-it.md) killed a `:13`
stagger because **leg one moved a lone job onto an already-occupied slot** — *"strictly worse"*.
⭐ **The transferable rule from it: verify the DESTINATION slot is empty before moving anything, and
verify it against live `cron.job`, not against the filing that motivated the move.** ⓘ Mechanism note
for whoever does it: `cron_heavy` jobs **are** reschedulable via `SET LOCAL ROLE`
([`2026-08-16T0030Z`](2026-08-16T0030Z-cron-heavy-jobs-ARE-reschedulable-from-mcp-via-set-local-role.md)),
so ownership is not the blocker.

**Ranked, each with the class that determines its remedy:**

1. **jobid 256 `rpc-thin-sale-ask-disclosure-refresh` — has never succeeded.** Not a tuning question:
   find out whether it *can* complete before deciding anything else. Cheapest item here.
2. **jobid 211 (Class C, ratio 15%)** — move it off `35 */6` to hours that are not multiples of 3.
   ✅ Evidence is within-subject and strong. ⚠ **Verify the destination slots first**, per above.
3. **Class B (215, 210, 302, 75, 236) — resolve the inconsistent ceiling.** A job succeeding at 771 s
   and dying at 602 s means the timeout is not what the schedule thinks it is. **Read each function's
   `SET statement_timeout` against its cron command's** — jobid 211's function carries its own
   `SET statement_timeout TO '600s'`, so the function, not the cron command, is authoritative there.
4. **Class A (71, 217, 73 — 61,570 s/7 d between them) — headroom.** Same call as known-issues #41,
   with the same caveat: **a failed run at 900 s wastes 900 s.** Watch `wasted_s`, not the failure
   count.

⚠ **All of it is one week of one instance, and the week contains a saturation spell partly of my
making. Re-measure §3's table over a clean week before acting on the hour-alignment claim.** §4's
within-subject table is the part that does not depend on that.
