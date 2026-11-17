# ⛔ CORRECTION TO MY OWN FILING 12 HOURS OLD — jobid 211 was fixed by an INDEX on 2026-08-28, my "six-week saturation dosimeter" reading is superseded, and #42's Class C diagnostic signature is REFUTED

**2026-08-29 11:1x PT / 18:1xZ · Claude Code (Trevor's box)**
**Supersedes [`2026-08-29T0425Z-jobid-211s-three-dead-slots-…`](2026-08-29T0425Z-jobid-211s-three-dead-slots-are-a-six-week-saturation-decay-and-deleting-them-burns-the-thermometer.md), written 04:2xZ the same night.**

---

## 1. What I got right, and it still stands

The Cowork cloud pass proposed cutting jobid 211 from `35 */6` to `35 0`, on the premise that the
other three slots **"have never worked."** ⭐ **That premise was false and the conclusion "do not
delete the slots" was correct.** Full retained history still reads **00:35Z 97.4% · 06:35Z 50.0% ·
12:35Z 52.6% · 18:35Z 41.0%**, reproducing #42's own slot table. ⚠ And #42 already carried the
warning in as many words — *"I nearly reported '0 of 19, the other slots never work' and the full
history says they work about half the time."*

## 2. 🚨 What I got WRONG: I diagnosed a symptom as a permanent instrument

My filing called jobid 211 **"an accidental dosimeter"** whose weekly non-00 success rate
(100 → 86 → 57 → 19 → 0 → 7%) was *"the most legible saturation-trend instrument on the box,"* and
argued the slots were worth keeping **for their diagnostic signal**.

⛔ **That reading is dead, and it was already dead when I wrote it.** The cause was not an abstract
instance-wide saturation trend. It was **one missing index**, and it had been diagnosed and fixed
about two hours before I filed.

`supabase/migrations/20260828225200_idx_pack_rips_dist_agg_covering.sql` (shipped 2026-08-28 on
Trevor's explicit call) states the mechanism outright:

> The only usable index was `idx_pack_rips_dist_id` — partial, keyed on `dist_id` ALONE — so the plan
> walked ~2,687,590 rows in dist_id order and HEAP-FETCHED every one … ~285,000 buffers ≈ 2.2 GB read
> to produce 3,120 rows. … Against the compute tier's 22 MB/s IO floor that makes jobid 211 **bimodal
> on CACHE RESIDENCY rather than on load**: warm pool → 50–74 s, cold pool → cannot finish in the
> 600 s ceiling.

## 3. The before/after, split on the change point

The index went in late on 08-28. jobid 211's very next tick, and every tick since:

| tick (UTC) | before/after | result |
|---|---|---|
| 08-28 08:35 / 14:35 / 20:35 | before | failed 600 s · failed 614 s · failed 600 s |
| **08-29 00:35** | after | **succeeded, 2 s** |
| **08-29 06:35** | after | **succeeded, 2 s** ← this slot was 0 of 7 |
| **08-29 12:35** | after | **succeeded, 2 s** ← this slot was 1 of 6 |

**From 32–74 s warm / 600 s cold, to 2 s on every slot.** `idx_pack_rips_dist_agg` is live: valid,
171 MB, **19,037 scans**.

⚠ **Attribution is a change-point argument, not an isolated A/B** — I did not run the MV's defining
query before and after. But the index names this exact job in its own header, the step is ~30×, it
lands on the first tick after the index, and it lifts the two slots that had been failing for weeks.

⭐⭐ **AN UNPLANNED CONTROL LANDED WHILE I WAS WRITING, AND IT IS THE STRONGEST EVIDENCE HERE.** The
daytime monitor's independent sweep at **18:06Z today** ([`2026-08-29T1806Z-…`](2026-08-29T1806Z-daytime-IO-band-materially-worse-than-yesterday-light-catalog-fn-now-times-out.md))
measured `pg_stat_activity` at **io_wait = 40, active = 41 of 51** — *"a majority of active sessions
in IO wait → confirmed IN a spell"* — against **io_wait = 9, active = 8 of 36** at the identical tick
yesterday, and reports that a **light** `cron.job_run_details` catalog function now times out where
yesterday every light indexed read returned fast.

👉 **So 08-29 carries the worst IO band on record for that tick — and jobid 211 succeeded in 2 s at
12:35Z on that same day.** Under the pre-index behaviour the migration describes (cold pool ⇒ cannot
finish in 600 s), a band this bad was a guaranteed failure. ⭐ **The confound points the WRONG way for
the null: if anything other than the index were responsible, today is the day it should have failed
hardest.** ⚠ This is still a change-point argument, not an A/B — but it rules out "the instance
happened to be quiet" as the explanation, which was the obvious alternative.

⏱ **PRE-REGISTERED FALSIFIER, resolvable today: the 18:35Z tick has not run yet at the time of
writing (18:1xZ).** 18:35Z is the WORST slot in the whole history (16 of 39, 41.0%). **If it succeeds
in ~2 s, all four slots are confirmed. If it fails at 600 s, the fix is partial and this filing is
the thing to re-open**, because 18:35Z is the coldest-pool slot and therefore the real test.

### ✅ FALSIFIER RESOLVED — 18:35Z SUCCEEDED, and HOW it succeeded is more informative than the pass

**08-29 18:35Z: `succeeded`, 40 s.** All four slots on 08-29 now read **2 s · 2 s · 2 s · 40 s**,
against a slot whose own history is **16 of 39 (41.0%)** with **every failure at exactly 600 s**.
⭐ **The fix holds on the worst slot, on the worst IO day on record for that tick.**

⭐⭐ **But 40 s is not 2 s, and that 20× spread inside a single day is the real finding.** 18:35Z ran
inside the spell the monitor measured at `io_wait 40 / active 41 of 51`; the other three did not. So
the job is **still IO-sensitive — it has simply stopped being BIMODAL.** Before the index a bad band
meant a 600 s kill; now it means 40 s, comfortably inside the ceiling. 👉 **State the fix precisely:
it did not make the query immune to contention, it made contention a COST rather than an OUTCOME.**
⚠ **So 40 s is the number to watch, not 2 s** — this slot has roughly **15× headroom** left against
its ceiling, not 300×.

ⓘ This retires the last open question in this filing; nothing here is left pending.

## 4. ⭐⭐ THE TRANSFERABLE FINDING — #42's Class C signature is wrong, and jobid 211 was its exemplar

known-issues **#42** classifies the fleet by `max(success duration) ÷ ceiling` and says of **Class C**:

> `refresh_allday_pack_realized` succeeds in **32–106 s** and fails at **600 s**. ⭐ **A clean bimodal
> split at exactly the ceiling is the signature of BLOCKING or STARVATION, not of slowness.**
> ⛔ **headroom will not help**

🚨 **Half right, and the half that is wrong is the actionable half.** "Headroom will not help" was
correct. **"Blocking or starvation" was not** — nothing was blocking. A bimodal split at the ceiling
is equally the signature of **a query whose cost is dominated by cache residency**: warm it fits,
cold it cannot, and there is no middle because the miss costs 2.2 GB of random IO. ⭐ **The remedy was
an index — i.e. exactly the "slowness" the classification ruled out.**

⛔ **This also removes #42's only controlled evidence.** #42's thesis is that cron waste is
**schedule alignment** rather than any one slow job, and jobid 211 was the one within-job control
offered for it — *"one function, one MV, four slots … The hour decides the outcome, not the job."*
⭐ **The hour was a PROXY for cache residency, not a cause.** The fleet-wide hour statistics are
untouched, but **the clean control is gone, and the job it was built on turned out to be a per-job
cost that one index removed.** 👉 **Re-test the remaining Class C members for a missing index before
treating any of them as blocking/starvation** — that is a hypothesis, not a result, but it is now the
cheaper one to check first.

## 5. ⚠ A dated sample changed under me inside one session — worth recording as method

My 04:2xZ filing reported the most recent week at **7% (1 of 15)**. Re-read at 18:1xZ the same
week is **17.6% (3 of 17)** — because two of today's ticks succeeded while I was working. **Same
query, same job, 14 hours apart, and the number moved by 2.5×.** ⭐ It also broke the "monotonic"
description I had already hedged. **A weekly bucket that includes the current, partial week is not a
data point yet**; I should have excluded it or stamped it as partial.

## 6. What to do

1. ⛔ **Do not take the `35 0 * * *` change.** The reason is no longer "keep the thermometer" — it is
   simply that **all four slots now work in 2 s**, so there is nothing to reclaim: the three "wasted"
   600 s runs no longer exist.
2. ✅ **Update #42**: mark the jobid-211 exemplar RESOLVED-BY-INDEX, retract the Class C
   blocking/starvation signature, and note that its controlled evidence is withdrawn.
3. ⏱ **Read the 18:35Z tick** (falsifier above) before calling this closed.
4. ⭐ **Retire the "dosimeter" idea.** The instrument existed only because the defect did.

## Reproduce

```sql
select to_char(start_time,'MM-DD HH24:MI') started_utc, status,
       round(extract(epoch from (end_time-start_time))) secs
from cron.job_run_details
where jobid = 211 and start_time >= now() - interval '3 days'
order by start_time;
```
