# Fourteen of 52 cron-route pipeline names have **no runs**, and seven of them ran for weeks and then **stopped** — found after fixing one of them by mistake

**Filed 2026-09-02 ~13:35 PT (20:35Z), Claude Code cloud session. NOTHING CHANGED.**
This is a **candidate list produced by a name-extraction regex**, not a finding. Every entry needs its
own confirmation before anyone deletes or re-enables anything. Read §4 before acting on any row.

## 0. Why this exists — I fixed a route that does not run

Earlier today I found a real PostgREST-cap truncation in
`app/api/cron/compute-laliga-pack-ev/route.ts`, measured it (1,958 pool rows / 211 dists / 134
reachable), fixed it, wrote four behavioural tests and mutation-tested them. **The route has not run
since August.** I never asked whether it executes — the rule "name the caller before you touch the
function" was right there and I skipped it. **The check is one query, and it belongs before the fix.**

So: run it against every cron route.

## 1. The method (re-runnable)

Extract the pipeline name from each `app/api/cron/**/route.ts`
(`p_pipeline:` / `PIPELINE_NAME =` / `pipeline:` string literal), then per name:

```sql
SELECT count(*) FROM public.pipeline_runs       WHERE pipeline = n OR pipeline = n || '-heartbeat';
SELECT max(day), count(*) FROM public.pipeline_runs_daily WHERE pipeline = n OR pipeline = n || '-heartbeat';
```

⚠ **Both halves are required.** `pipeline_runs` retains ~73 h, so zero there cannot distinguish
"never ran" from "ran outside retention"; `pipeline_runs_daily` is indefinite (but six-hourly, so it
is a liveness signal, not a recency one). **70 route files → 52 distinct pipeline names.**

## 2. Ran for weeks, then STOPPED — the interesting group

| pipeline | first day | last day | days |
|---|---|---|---:|
| `topshot-flowty-sales-history-backfill` | 2026-07-29 | **2026-08-17** | 20 |
| `topshot-flowty-unmapped-drain` | 2026-07-29 | **2026-08-17** | 20 |
| `compute-laliga-pack-ev` | 2026-08-02 | **2026-08-23** (heartbeat 08-27) | 20 |
| `ownership-sync-dune` | 2026-08-03 | **2026-08-24** | 4 |
| `ufc-sales-history-backfill` | 2026-07-29 | **2026-08-27** | 30 |
| `topshot-deal-floor-serials` | 2026-07-29 | **2026-08-30** | 33 |
| `wallet-username-resolver` | 2026-07-29 | **2026-08-30** | 33 |

ⓘ **The two `topshot-flowty-*` rows are almost certainly CORRECT to be stopped** — Flowty's
marketplace shut down and this repo records that. They are listed for completeness, not as defects.

## 3. No runs and no daily history at all

`cadence-payer-balance-check` · `refresh-cross-collection` · `refresh-serial-fmv-multipliers` ·
`sales-ingest-dune` · `sales-serial-backfill-trigger` · `signup-reminder` · `weekly-digest`

⚠ **This group is the LEAST trustworthy.** Zero daily rows is at least as likely to mean *the route
logs under a name my regex did not extract* (a variable, a suffix, a template) as it is to mean the
route never runs. `sales-serial-backfill-trigger`, for instance, plausibly logs as the edge function's
own name. **Confirm per route by reading its `log_pipeline_run` call, not by trusting this list.**

## 4. ⛔ What NOT to conclude, and why nothing was changed

- ⛔ **"No runs" ≠ "no callers."** This sandbox can see `pg_cron`, `vercel.json`, GHA workflows and
  the repo. It **cannot see cron-job.org or the Windows Task Scheduler on Trevor's box**, and this
  repo documents both as real producers of production traffic. That is five of eight caller sources.
- ⛔ **The successor can have a DIFFERENT NAME, so name-matching finds nothing.** `compute-laliga-pack-ev`'s
  live counterpart is the edge function `compute-golazos-pack-ev` — and ⭐ **it is not even a
  successor: it started 2026-07-29, four days BEFORE the route did.** The route was a second,
  redundant producer that was later switched off. `compute-allday-pack-ev` and
  `compute-pinnacle-pack-ev` have run every day since 2026-07-29 too; the laliga route was the odd
  one out. **Do not assume "stopped" means "replaced".**
- ⛔ **A stopped pipeline is not automatically a dead route** — it may be a *disabled* schedule for
  something that should be running. `topshot-deal-floor-serials` and `wallet-username-resolver` both
  stopping on 2026-08-30 is a coincidence worth explaining before either is deleted OR re-enabled.

## 5. What this is worth

Two different things, and they should not be conflated:

1. **A pre-flight for anyone editing `app/api/cron/**`** — the two queries in §1, run BEFORE the fix.
   Written up in [cron-and-schedulers.md](../../reference/cron-and-schedulers.md).
2. **A triage list for Trevor**, who can see cron-job.org and the Task Scheduler and can therefore
   turn these candidates into answers. Five of the seven in §2 stopping within a fortnight is either
   a deliberate cleanup nobody wrote down, or several schedules that fell over quietly.

## 6. Falsifier

Re-run §1. **If a name in §2 or §3 shows a `last_day` of today, it is alive and this filing was wrong
about it** — the likeliest cause is that it runs on a cadence longer than the window, or logs under a
name the regex missed. If §2's list grows, schedules are still being lost.
