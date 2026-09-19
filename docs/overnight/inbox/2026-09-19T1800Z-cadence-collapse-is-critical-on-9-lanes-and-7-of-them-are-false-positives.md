# `Cadence Collapse` is CRITICAL on 9 lanes and **7 of the 9 are false positives**

**Filed 2026-09-19 11:00 AM PT (Cowork cloud). READ-ONLY — nothing shipped.** This is the arm that
drove **15 of the 22 CRITICAL sentinel pages in 48 h**, and until today its page carried none of
this: its 400-character detail was entirely consumed by an expired-ack prefix (fixed separately
today, `clampSentinelDetail`). This filing is what the arm was actually trying to say.

## What it reports (run by hand, `public.check_pipeline_cadence_collapse()`)

`stopped_count 1` + `degraded_count 8` = **9** against `crit_at = 5` ⇒ CRITICAL.
Window: 12 h observed, 14-day baseline ending 3 days back (09-02 → 09-16), ratio floor 0.40,
`min_baseline 24`, 97 lanes inspected, 48 heartbeats excluded.

| entry | ratio | verdict |
|---|---|---|
| `offers-sweep` (**stopped**, baseline 72/day) | — | ⛔ **FALSE POSITIVE — deliberately retired** |
| `wallet-backfill` | 0.311 | ⛔ **FALSE POSITIVE — demand-driven** |
| `wallet-backfill-multicollection-dispatch` | 0.376 | ⛔ same |
| `wallet-backfill-multicollection-complete` | 0.376 | ⛔ same |
| `wallet-backfill-golazos` | 0.376 | ⛔ same |
| `wallet-backfill-ufc` | 0.376 | ⛔ same |
| `wallet-backfill-pinnacle` | 0.384 | ⛔ same |
| `ts-listings-atlas-sync` | 0.256 | ✅ **REAL** — already tracked |
| `fmv-recalc` | 0.360 | ✅ **REAL** — already tracked |

⭐ **Remove the seven and the count is 2, which is under `crit_at = 5`.** The arm would read WARN,
not CRITICAL. **Those seven entries are the entire reason this arm pages at CRITICAL.**

## Why each is a false positive

### 1. `offers-sweep` — retired on purpose, and the retirement is documented in-tree

`.github/workflows/dead-lane-backstop.yml` records it at length: the lane is Top-Shot-only and
calls `https://public-api.nbatopshot.com/graphql`, **decommissioned since ~2026-08-28** and
answering Cloudflare **530**. It was made INACTIVE on cron-job.org (job 7712610) on **2026-09-07**
and its watchlist row retired. That file explicitly forbids re-enabling it against the dead host.

📏 Corroborated from `pipeline_runs_daily`: 09-01..09-06 ran **72/day at exactly 36 ok / 36 fail
with 0 rows written every single day** (the 36/36 split is the route's own half-open breaker
logging `ok=true, skipped`, behaving as designed), then 9 runs on 09-07, 6 on 09-11, 1 on 09-12,
and nothing since.

⚠ **It is in this arm's output only because the arm's baseline is DERIVED FROM `pipeline_runs_daily`,
not from the watchlist** — so retiring the watchlist row did not remove it here. It should
self-clear when the last high-volume day (09-06) leaves the 17-day lookback, i.e. **around 09-23**
(derived, not observed — re-derive rather than quote).

### 2. The six `wallet-backfill*` lanes — a rate model applied to a demand-driven lane

🚨 **This is a category error, not a tuning problem.** Read straight off a dispatch run's `extra`:

```
"phase": "dispatch", "wallets_targeted": 1, "wallet_address": "0xe1f2a091f7bb5245",
"dispatched_per_collection": { all five collections: 0 },
"sync_collections_pending": ["nfl_all_day", "disney_pinnacle"]
```

**Each run handles exactly ONE wallet**, and the runs arrive in bursts (two at 17:30:43.24 /
17:30:43.264, then nothing back to 13:27:56). The lane appears in **no** `vercel.json` cron, **no**
GitHub workflow and **no** `cron.job` row — its run count is a function of how many wallets need
refreshing, i.e. **demand**, not of a clock.

⭐ **And the health evidence points the other way from the ratio:** over the fall from ~550/day to
~315/day, `ok_count` stayed at **96–98 %** (09-19: 74 ok of 77; 09-18: 308 of 312; 09-17: 307 of
313). **A collapsing lane fails; this one succeeds at the same rate and is simply asked to do less.**
The six siblings move in lockstep (observed_runs 99/99/99/101) because one dispatcher fans out to
five collection legs plus a completion leg — **six rows, one cause.**

⚠ **What is NOT claimed:** that the drop in demand is itself fine. Runs fell ~550/day (09-01..09-12)
→ 433 (09-13) → ~315/day (09-14..09-18) → 77 so far on 09-19, and `rows_written` today is **7**
against 4,694 yesterday. **Whether fewer wallets SHOULD be refreshing is a real question — it is
just not the question this arm is asking, and this arm cannot answer it.**

## Candidates for the fix, in order of how well they respect the standing rules

1. ⭐ **Make the population the set the property is TRUE of** — the rate model is only valid for
   lanes with a *scheduled* cadence. A demand-driven lane has no stable per-day baseline, so it
   should not be scored by one. ⚠ The function cannot see cron-job.org, so "is it scheduled?"
   cannot be derived from the DB — this needs an explicit marker (a column on
   `pipeline_cadence_watchlist`, or a `demand_driven` set), which is a curated list and should
   therefore be the *suppression*, not the population.
2. **Require the drop to PERSIST** — N consecutive 12 h windows below ratio, not one. Demand
   fluctuates; a genuine collapse does not recover on its own. This needs no new curation and
   would have excluded all six wallet lanes without naming them.
3. **Pair the ratio with the OK RATE.** A lane at 96 % ok and 38 % of baseline is being asked to do
   less; a lane at 30 % ok and 38 % of baseline is broken. ⛔ Do not use ok-rate alone — the
   `offers-sweep` 36/36 breaker split shows ok-rate is itself gameable by a breaker.
4. ⛔ **Do NOT just raise `crit_at` above 9.** That silences the arm by exactly the amount of noise
   present today and would hide a tenth, real lane tomorrow. The count is not the defect; the
   population is.

🔬 **Falsifier for any of these:** re-run `check_pipeline_cadence_collapse()` and confirm
(a) `ts-listings-atlas-sync` and `fmv-recalc` are STILL reported — they are the true positives and
must survive any change — and (b) the six wallet lanes are absent **while their `ok_count` is still
96 %+**. ⚠ If the wallet lanes vanish because their ok-rate fell too, the change is unproven and
the lane is now genuinely broken; **split on that, do not pool.**
