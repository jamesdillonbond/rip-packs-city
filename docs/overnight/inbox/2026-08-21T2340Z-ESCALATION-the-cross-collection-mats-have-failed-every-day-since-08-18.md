# ESCALATION — the cross-collection mats have failed EVERY daily run since 08-18, the board is 4d19h stale, and the 08-18 filing's own escalation trigger fired three days ago

**Filed 2026-08-21 ~16:40 PT (23:40Z), Claude Code interactive. MEASURED. The DISCLOSURE half is
SHIPPED (see the ledger entry of the same date); the REFRESH half needs a decision, stated below.**

---

## ⚠ 0. SUPERSEDED IN PART — §5's blocking trade was dissolved the same night, by another session

**Read this before acting on §5.** A concurrent session re-derived §5's blocker and showed it is **not
inherent to the work — it is where the `TRUNCATE` sits.** `cross_collection_cohort_mat` holds only
**179 rows**; all the cost is the aggregate scan over `wallet_moments_cache` (~2.49M rows) and the write
is trivial. Computing into a `TEMP TABLE … ON COMMIT DROP` and truncating immediately before the insert
shrinks the ACCESS EXCLUSIVE window from **105–350 s to milliseconds**, with identical output and
identical all-or-nothing semantics. Equivalence proven with `EXCEPT` in both directions, 5 of 5 mutants
killed. Migration + test committed, deliberately unapplied.

**So §5's "that trade is Trevor's, not mine" no longer holds** — my reading was fair on the evidence I
had and is now superseded. ⚠ **What still stands from §5:** the queries are no faster, so the 04:10Z runs
keep timing out; this removes the OBJECTION to the schedule move, it is not the move. The
`cron.alter_job` step and **the next-day verification that it actually took** are unchanged and still
required. Apply both in the 20:00–00:00Z window.

**This is the "a filed decision NOT to act is a hypothesis" rule landing on my own filing, four hours
old.** The tell was there in §5 and I did not follow it: I stated the lock duration as a property of the
job ("for the whole transaction") without asking whether the job had to be shaped that way.

---

## 1. What is broken

`/insights/cross-collection` (public, crawlable, in the sitemap) is served from three materialised
tables rebuilt by a daily pg_cron pair. `cron.job_run_details`:

| run (UTC) | rpc-ccm-step1 | rpc-ccm-step2 |
|---|---|---|
| 08-16 04:10 / 04:25 | succeeded, 161 s | succeeded, 10 s |
| 08-17 04:10 / 04:25 | succeeded, **350 s** | succeeded, 9 s |
| 08-18 | **failed, 600 s — statement timeout** | **failed, 300 s — statement timeout** |
| 08-19 | failed, 600 s | failed, 300 s |
| 08-20 | failed, 600 s | failed, 300 s |
| 08-21 | failed, 600 s | failed, 300 s |

`max(computed_at)` on all three tables is **2026-08-17 04:10Z — 4 days 19 hours** as of filing.

## 2. ⚠ The escalation condition was written down, was met on 08-19, and nobody re-checked

The 2026-08-18 18:35Z filing closed this item as *"SATURATION … No fix needed; it self-heals at the
next clean 04:10Z tick"* and set an explicit trigger: **"escalate only if it fails a second consecutive
day."** It has now failed on **four** consecutive days. This is CLAUDE.md's own rule, live: *a filed
DECISION NOT TO ACT is a hypothesis, and it is the one nobody re-checks* — and *re-TEST a stated exit
condition, never re-read it.* The disposition was reasonable when written; it was simply never tested.

## 3. That filing's measurement was RIGHT, and the piece it was missing makes it decisive

Its rolled-back probe measured the exact aggregate at **105 s against the 600 s ceiling** and concluded
"6× headroom, so the kill was IO pressure". Both halves hold. The missing piece is **how big the
pressure is and when** — measured today (see the 23:15Z filing):

- The estate runs ~3–18× slower for ~20 hours a day (01:00–19:00Z), on a control unrelated to this job:
  `rpc-backfill-wmc-fmv-confidence`, identical 5-minute schedule, p50 **0.7–1.0 s in 20–00Z vs
  3.1–18.0 s in 01–19Z**.
- **`rpc-ccm-step1` fires at 04:10Z — squarely inside that band.**

So the "6× headroom" is exactly what the band consumes: 105 s × 3.3 ≈ 350 s (the 08-17 run), 105 s ×
5.7+ > 600 s (every run since). ⚠ **The growth reading was refuted for the right reason and the
self-heal prediction still failed, because there is no longer a clean 04:10Z tick to wait for.**

## 4. What was SHIPPED — disclosure only

The board rendered **no age at all**, and the tempting field was a trap: `meta.fetched_at` is stamped
`new Date()` at READ time by both the page and the API route, so rendering it would have claimed
"updated seconds ago" over five-day-old data. The honest instant is `stats.computed_at`, which
`select("*")` has always returned and nothing ever typed or displayed. Now rendered, with a test that
pins the DISTINCTION (falls back to `—`, never to the read clock) rather than the mere presence of a
stamp. Details in the ledger.

## 5. ⚠ The fix I did NOT ship, and exactly why

**One line:** `SELECT cron.alter_job(60, schedule := '10 23 * * *');` and the same for jobid 4
(`'25 23 * * *'`), moving both into the healthy window (hour 23Z is the quietest measured: `deals`
failed 0% of ticks there on all three retained days; cron busy-seconds 1,128 vs 4,000–13,000 in-band).
On the measured numbers the work fits with room to spare there.

Three reasons it is a decision, not a chore:

1. ⚠ **`refresh_cross_collection_cohort_step1` opens with `TRUNCATE`**, which takes ACCESS EXCLUSIVE on
   a table the public board reads, for the whole transaction (~105–350 s). The 08-18 filing declined a
   manual daytime catch-up for precisely this reason. **23:10Z is 4:10 pm PT** — the healthy window IS
   the Pacific afternoon, so there is no window that is both fast and off-hours. That trade is Trevor's.
2. ⚠ **`cron.alter_job(id, schedule := …)` is recorded as NOT having taken effect once** (same 08-18
   filing: a job re-aimed at `'28 * * * *'` never fired at 18:28; a freshly `cron.schedule`d job fired
   on time). For a daily job moved by 19 hours a short reload lag is probably irrelevant — but it is
   unverified, and the verification is a day away. **How to check:** tomorrow, read
   `cron.job_run_details.start_time` for jobids 60 and 4. If either still starts at 04:10/04:25Z the
   alter did not take, and the fix is `cron.schedule` a fresh job plus `cron.unschedule` the old one.
3. **Failure is bounded and non-destructive either way** — if the move does not take, the jobs keep
   failing exactly as they do now. There is no downside path except the daytime lock in (1).

**Alternatives, weaker:** raising `cron_heavy`'s role-level `statement_timeout` above 600 s is global
and would let other heavy jobs run longer inside the bad band. ⚠ Note the function's own
`proconfig statement_timeout=180s` is INERT (it ran 600.2 s) — the binding value is the role's, as
CLAUDE.md records. Making `step1` incremental instead of TRUNCATE-and-rebuild removes the lock problem
permanently and is the real fix, but it is function logic and a much larger change.

## 6. What this does NOT say

It does not say hour 23Z is safe forever — the healthy window is a measured property of this week's
load, not a constant, and the band has already widened once (05–08:30Z → 01–19:00Z). Whatever is moved
there should be re-measured, not assumed. And nothing here fixes the 20-hour slowdown itself; see the
23:15Z filing for that, where the same window is costing FMV recalc ~19 hours a day.
