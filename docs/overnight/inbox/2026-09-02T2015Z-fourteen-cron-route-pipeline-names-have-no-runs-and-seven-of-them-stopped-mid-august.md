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


---

# TRIAGE, same session ~13:50 PT — 2 of 7 checked, and ⭐ THE OUTPUT TABLE IS A BETTER FALSIFIER THAN THE PIPELINE NAME

§6 above proposed re-running the liveness query as the falsifier. **There is a stronger one, and it
discriminated these two cleanly on the first try: look at what the pipeline WRITES.** A pipeline name
can stop while the work continues under another name; an output table cannot lie about being frozen.

## ✅ CONFIRMED STOPPED — `wallet-username-resolver`

`wallet_usernames.max(updated_at)` = **2026-08-30 15:59:50Z** — the *same instant* the pipeline stopped
logging. 9,370 rows, nothing touched since. The table is frozen at the moment the pipeline died, which
is about as unambiguous as this gets.

**The cost, measured with a matched control** — distinct buyer wallets with no `wallet_usernames` row,
over ~3-day windows either side of the stop:

| window | wallets | missing | % |
|---|---:|---:|---:|
| pre-stop (08-27 → 08-30 16:00Z, 3.0 d) | 640 | 26 | **4.1%** |
| post-stop (08-30 16:00Z → now, ~3.2 d) | 487 | 29 | **6.0%** |

⚠ **State the size honestly: 29 vs 26 is a small absolute difference on small numbers**, and the 4.1%
baseline is the floor of wallets that simply never set a username. The incremental effect is ≈1.9
points, roughly **3 newly-unresolvable wallets per day and growing**. The unarguable half is the
frozen `updated_at`, not the percentage. `wallet_usernames` is read by `/api/public/special-serial-owners`,
`lib/edition/fetchers.ts`, `lib/pinnacle/moment-detail.ts` and `/api/admin/rewards`, so the visible
symptom is a raw `0x…` address where a name used to appear — degraded, **not a false claim**.

## ⛔ REFUTED — `topshot-deal-floor-serials` is doing its job

Its pipeline name last logged 2026-08-30, exactly like the one above. **Its output is current:**
`edition_offers.low_ask_serial` has `max(updated_at)` = **2026-09-02 18:22Z (today)**, with 1,469 of
1,479 rows touched in the last 7 days. Something is still writing those serials under a different
name. ⭐ **Two pipelines, identical evidence in `pipeline_runs_daily`, opposite conclusions** — which
is exactly why §4 says "no runs ≠ no callers" and why this list is candidates rather than findings.

## ⚠ Neither has a pg_cron job at all

`cron.job` has **zero** rows matching either. Both were driven by something invisible from a sandbox —
cron-job.org, a GHA workflow, or the Task Scheduler on Trevor's box. So for
`wallet-username-resolver` the open question is **"was its schedule deliberately removed, or did it
fall over?"** and ⛔ **that is Trevor's to answer, not mine** — re-enabling a schedule someone turned
off on purpose is the mirror-image mistake of leaving a broken one dead. **Nothing re-enabled.**

## Updated falsifier for the remaining 5

For each: find the table it writes and compare `max(updated_at)` against its last logged day.
**Same instant → confirmed stopped. Still current → refuted, and its driver was renamed.**


---

# TRIAGE COMPLETE ~14:25 PT — all 7 checked. **Exactly ONE is a real problem.**

Applied the output-table falsifier to the remaining five. The result argues strongly for filing lists
like this as candidates: **6 of 7 are correct, superseded, or already working.**

| # | pipeline | output evidence | verdict |
|---|---|---|---|
| 1 | `topshot-flowty-sales-history-backfill` | Flowty's marketplace shut down May 2026; **0** sales carry `source='flowty'` | ✅ **correct to be stopped** |
| 2 | `topshot-flowty-unmapped-drain` | same | ✅ **correct to be stopped** |
| 3 | `compute-laliga-pack-ev` | edge fn `compute-golazos-pack-ev` runs 6-hourly and predates it | ✅ **redundant producer, switched off** |
| 4 | `ownership-sync-dune` | dune-sourced `topshot_ownership` frozen **2026-08-14**, but the table overall is current (**2026-09-02 13:30Z**) via `source='onchain_walk'` | ⓘ **lane superseded, table healthy** |
| 5 | `ufc-sales-history-backfill` | UFC's newest sale is **2026-05-13 17:06Z**, 0 sales in 30 d — its Flow market **closed** that day | ✅ **correct to be stopped; nothing to backfill** |
| 6 | `topshot-deal-floor-serials` | `edition_offers.low_ask_serial` current **today**, 1,469/1,479 rows in 7 d | ⛔ **refuted — driver renamed** |
| 7 | `wallet-username-resolver` | `wallet_usernames.max(updated_at)` frozen at **2026-08-30 15:59:50Z**, the same instant it stopped logging | 🚨 **CONFIRMED STOPPED** |

## ⭐ What the 6-of-7 result is worth

**A "stopped pipeline" list is mostly noise, and the noise has FIVE different causes** — a dead
upstream marketplace (×2), a closed collection market, a redundant producer, and a renamed driver.
None of those is a defect; only one is. **Publishing this as a findings list would have been ~86%
false alarms**, which is the same precision problem as the #57 static scan (15 of 19 refuted) and the
same reason neither became a guard.

👉 **The falsifier is what made it cheap**: one query per pipeline against the table it writes,
versus reading seven routes and their schedules.

## The one real item, restated

`wallet-username-resolver` — output frozen 2026-08-30 15:59:50Z, no `cron.job` row, driver invisible
from a sandbox. Measured cost: buyer wallets with no username row went **4.1% → 6.0%** across matched
~3-day windows either side of the stop (29 vs 26 missing — small absolute numbers; the unarguable
half is the frozen timestamp). ⛔ **Still not re-enabled** — whether its schedule was deliberately
removed or fell over is not answerable from here, and those two facts want opposite actions.

## §3's seven remain untriaged, and deliberately so

The "no runs and no daily history at all" group is still the least trustworthy list in this filing:
zero daily rows is at least as likely to mean *the route logs under a name the regex missed*. They
need a read of each route's `log_pipeline_run` call, not another query.
