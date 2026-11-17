# 🚨 PROVEN BY EXPERIMENT — **48 pg_cron jobs declare a `statement_timeout` that has no effect**, and one of them has been failing daily for 14 days because of it

**Filed 2026-08-26 (PT) / 2026-08-27 04:50Z by Claude (Cowork cloud). NOTHING SHIPPED.**
**Four probes, run and cleaned up; the mechanism is measured, not inferred.**

---

## 1. The thread that led here

Known-issues **#42** flagged `rpc-thin-sale-ask-disclosure-refresh` (jobid 256) as a job with no
successes in the retained window. Its function is unusually careful:

```sql
CREATE OR REPLACE FUNCTION public.fmv_thin_sale_ask_disclosure_refresh()
  ... SECURITY DEFINER
  SET statement_timeout TO '900s'          -- (a) proconfig
AS $function$
BEGIN
  -- Applies to this transaction regardless of the caller's configured timeout.
  -- The first scheduled run died at exactly 120s despite proconfig saying 300s.
  PERFORM set_config('statement_timeout', '900s', true);   -- (b) belt and braces
```

**900 seconds, declared twice. Every run dies at exactly 600.** ⭐ **And the comment records that the
author already hit this once, diagnosed the symptom correctly — and reached for a second fix of the
same shape as the one that had just failed.**

## 2. ⭐⭐ The mechanism, proven in four probes

`statement_timeout` arms a timer **once, when the top-level statement begins**, from the value in
effect at that moment. **Changing the GUC inside a function does not re-arm it — in either
direction.**

| probe | setup | result |
|---|---|---|
| **A — can proconfig RAISE?** | fn with `SET statement_timeout TO '10s'`, sleeps 4 s, session at **2 s** | ⛔ **killed at 2 s** |
| **B — can `set_config(…, true)` RAISE?** | same, using `set_config('statement_timeout','10s',true)` inside | ⛔ **killed at 2 s** |
| **C — can proconfig LOWER?** | fn with `SET statement_timeout TO '1s'`, sleeps 4 s, session at **20 s** | ✅ **FINISHED** — and `current_setting('statement_timeout')` **inside** read `1s` |
| **D — does a leading `SET` work?** | `SET statement_timeout='2s'; SET …='9s'; SELECT pg_sleep(4)` | ✅ **completed**, effective `9s` |

🚨 **Probe C is the one to remember: a function whose declared timeout is 1 second ran for 4 seconds
while reporting `1s` from `current_setting()`.** ⭐ **A diagnostic that asks the session "what timeout
am I under?" gets an answer that is true about the GUC and false about the behaviour.** That is
exactly why this has survived: every check anyone could run says the setting is applied.

**Probe D is the remedy, and this repo already wrote it down** — the ledger's *"the working form is a
TWO-STATEMENT cron command … which pg_cron runs in one implicit transaction with the SET as its own
top-level command."* **The SET has to be its own statement, not inside the function.**

## 3. The population: 48 jobs

Active pg_cron jobs whose target function declares a `statement_timeout` in `proconfig`:

| owner | leading `SET` in the cron command? | jobs | declares > 600 s | = 600 s | **< 600 s** |
|---|---|---:|---:|---:|---:|
| `cron_heavy` | **no** | **36** | 1 | 9 | **26** |
| `postgres` | **no** | **12** | 0 | 0 | **12** |
| `postgres` | yes ✅ | 7 | 0 | 5 | 2 |

**48 jobs carry an inert declaration; 7 use the working form.** `cron_heavy`'s `rolconfig` is
`statement_timeout=600s`, so **all 36 of its jobs actually run at 600 s** whatever their function
says. `postgres` has **no** `statement_timeout` in `rolconfig`, so its 12 run at the cluster default.

⭐ **The fiction runs in BOTH directions, and the second one is the surprising half.** Only jobid 256
declares *more* than it gets. **Twenty-six `cron_heavy` jobs declare 60–480 s and are actually free
to run to 600 s** — a job written to stop after a minute can burn ten.

## 4. ✅ Cross-checked against the live failure data, and it fits exactly

- **jobid 217 `rpc-atlas-pack-ev` declares 120 s, has SUCCEEDED at 595 s and fails at 600 s.** Its
  120 s never bound anything. **This is independent confirmation of probe C on production data.**
- **jobid 73 `rpc-refresh-mv-pack-ev-latest` declares 120 s, max success 589 s, fails at 600 s.** Same.
- **jobid 215 declares 120 s and shows a 731 s "success"** — ⓘ that one is not a contradiction: its
  cron command is **two statements**, and each top-level statement gets its own 600 s.
- ⚠ **jobid 210 shows a 771 s success on a single statement, which this does NOT explain.** The
  likeliest reading is that `cron.job_run_details.start_time` includes **queue wait** — 32
  `cron.max_running_jobs` against `max_worker_processes = 6` — so the recorded duration is not
  statement time. **Recorded as unexplained rather than smoothed over**, and it means #42's
  `max(success) ÷ ceiling` ratio has queue-wait noise in it. ⛔ **#42's "Class B — already exceeds
  its ceiling" is therefore weaker than filed and should not be read as a distinct fault class
  until the queue-wait share is measured.**

## 5. 🚨 The consequence for #42's waste numbers

**jobid 217 declares 120 s and wasted 22,360 s in 7 days at 600 s per failure. jobid 73 declares
120 s and wasted 15,114 s.** Had their declared budgets been real, those two would have wasted
**~7,500 s instead of ~37,500 s — a 5× cut, with no query changed**, purely because a run that is
going to fail should fail fast.

⛔ **But "make the declarations real" is NOT the recommendation, and it would be a mistake.**
**Jobid 217 has SUCCEEDED at 595 s. Enforcing its declared 120 s would convert most of its
successful runs into failures.** The declarations were written by people who never saw them take
effect, so **there is no reason to believe any of the 48 numbers reflects a considered budget.**

👉 **The honest conclusion: the declared budgets are fiction and must be reconciled deliberately,
one job at a time, against each job's observed success distribution. Until then, nobody may read a
function's `proconfig` as a budget** — not in review, not in an incident, not when tuning.

## 6. 👉 Ordered, and none of it shipped

1. **jobid 256 specifically.** ⓘ **Correction to #42: it is not "never succeeded" — the cache holds
   216 rows stamped `2026-08-13 09:25:00Z`. It succeeded once and has failed every day for 14 days.**
   ⛔ **And do NOT just raise its budget: `fmv_thin_sale_ask_disclosure_cache` has NO consumer** — 0
   functions, 0 views, 0 matviews, no `anon`/`authenticated` grant, and no reference in `app/ lib/
   components/ supabase/functions/ scripts/`. **It burns 600 s a day of the instance's binding
   constraint to fill a table nothing reads, and it serves 14-day-old rows to anyone who does.**
   ⚠ "No consumer found" is not "no consumer" — it may be read ad hoc, or built for a board never
   shipped. **That is a question for Trevor, and it is the cheapest item in #42 either way.**
2. **Decide the reconciliation policy** for the other 47 before touching any individual one.
3. **Only then** consider #42's Class A headroom — the two questions interact, and moving a ceiling
   while the declared ceiling is fiction is how this state was reached.

⚠ **All four probes created and dropped their own functions; two rolled back with their failing
batches. Verified: zero `_tmp_*` functions remain, `check_secdef_anon_execute_violations()` → `[]`.**
