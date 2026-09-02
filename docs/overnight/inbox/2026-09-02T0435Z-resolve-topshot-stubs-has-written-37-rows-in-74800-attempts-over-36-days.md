# `resolve-topshot-stubs` has written **37 rows in 74,800 attempts over 36 days** — 520 permanently-stuck editions re-queried ~4× a day

**Filed 2026-09-01 ~21:35 PT (2026-09-02 ~04:35Z), Claude Code cloud session.**
**Nothing changed.** Found by sweeping for the class two of tonight's fixes belong to — *which
pipelines find work and convert none?* — not by a filing. The measurement is solid; the **decision is
not mine**, and the cheap fix has a trap in it.

## The number, and it comes from the DURABLE rollup, not the 73 h table

`pipeline_runs_daily` (indefinite retention) for `resolve-topshot-stubs`:

| | |
|---|---:|
| days recorded | **36** (2026-07-29 → 2026-09-02) |
| runs | **1,497** |
| targets processed (`rows_found`) | **74,800** |
| rows written | **37** |
| yield | **0.049 %** |
| best single day | 32 — i.e. **5 rows in the other 35 days** |

⚠ **Deliberately measured from `pipeline_runs_daily` and not `pipeline_runs`**, which retains ~73 h —
a 3-day window would have shown `0 / 2,300` and been indistinguishable from a brief outage. The
36-day shape is what makes this a standing state rather than a bad afternoon.

## What it is doing

`get_topshot_stub_targets(50)` selects Top Shot editions missing `player_name`, `set_name` or `tier`
that carry both on-chain ids. **520 editions qualify, and all 520 were touched in the last 24 h** —
so the queue cycles completely about **4.4 times a day** (46 runs × 50 ÷ 520).

Every run reports `targets_found: 50 · rows_resolved: 0 · rows_no_change: 50 ·
rows_no_change_no_onchain_player: 50` — the chain has no player name for any of them.

⭐ **This is NOT the treadmill the buyer-backfill lane had, and the difference matters.** That one
re-picked the identical 45 rows because it had no rotation. This picker was written with rotation on
purpose — `ORDER BY updated_at ASC NULLS FIRST`, with a comment saying exactly why — and it works.
**The rotation is doing its job; the job has nothing left to find.**

## Cost, stated honestly

~2,300 chain lookups a day through the edge function, plus ~2,300 `editions` UPDATEs a day whose only
effect is bumping `updated_at` (that bump is what drives the rotation, so it is not waste in the
ordinary sense — it is the mechanism). On a table this size that is row churn, index maintenance and
autovacuum load for a 0.049 % yield. **It is not urgent and nothing is wrong;** the question is whether
a 520-row queue is worth 4.4 sweeps a day.

## ⛔ The obvious cheap fix has a trap — do not ship it without thinking

*"Exclude editions attempted in the last 24 h"* cuts the work 4.4× at no loss of coverage. **But the
attempt bump and the freshness signal are THE SAME COLUMN.** A brand-new stub edition also has a recent
`updated_at`, so that predicate would delay every genuinely new stub by up to 24 h — trading a real
capability for a saving on a queue that is already bounded.

**What the fix actually needs is a discriminator that does not exist yet: attempt time separate from
change time.** Options, in increasing order of blast radius:

1. `editions.stub_attempted_at` (a nullable timestamptz — instant to add on PG 11+), stamped by the
   RESOLVER. ⛔ The resolver is `supabase/functions/topshot-stub-resolver/index.ts`, so this needs an
   edge deploy.
2. The same column stamped by the PICKER instead — `get_topshot_stub_targets` becomes VOLATILE and
   marks what it hands out. **No deploy at all**, and it survives a resolver crash (the rows stay
   marked, which is the right behaviour for a backoff). ⚠ A claim function that writes is surprising
   and deserves a loud comment.
3. Decide the 520 are permanently unresolvable and retire or heavily slow the schedule. **Trevor's
   call** — it asserts the Top Shot catalog will never gain these plays.

👉 With a real attempt column, the right shape is an **exponential backoff** on attempts, not a flat
exclusion: a stub that has failed 200 times does not deserve the same cadence as one that has failed
once.

## Falsifier / re-derive before acting

Re-run the rollup query above. **If `rows_written` over the trailing 30 days is materially above ~40,
this filing is wrong and the queue is productive.** Also re-count the qualifying population: 520 today;
if it is growing, new stubs ARE arriving and option 3 is off the table.

**Risk of acting: low. Risk of not acting: also low** — which is exactly why it has run for 36 days
without anyone noticing.

---

## The sweep that found it — and why it must stay a TRIAGE TOOL, never an alarm

Re-runnable, and it reads only the indefinite rollup, so it is not bounded by the 73 h table:

```sql
SELECT pipeline, count(*) days, sum(runs) runs, sum(rows_found) found, sum(rows_written) written,
       round(100.0*sum(rows_written)/NULLIF(sum(rows_found),0), 3) AS yield_pct
FROM pipeline_runs_daily WHERE day > current_date - 30 GROUP BY 1
HAVING sum(rows_found) >= 5000 AND sum(rows_written) * 200 < sum(rows_found) AND count(*) >= 10
ORDER BY sum(rows_found) DESC;
```

**Nine pipelines, 30 days:**

| pipeline | runs | found | written | yield |
|---|---:|---:|---:|---:|
| `snapshot-pack-asks` | 8,147 | 24,090,015 | 9,413 | 0.039 % |
| `allday-price-recover` | 2,054 | 2,026,000 | 1,888 | 0.093 % |
| `pack-events-ingest-backfill` | 2,647 | 190,001 | **0** | 0 % |
| `pinnacle-listings-retry` | 2,704 | 92,164 | **0** | 0 % |
| `topshot-subedition-circulation-backfill` | 18 | 67,484 | 4 | 0.006 % |
| `topshot-stub-resolver` / `resolve-topshot-stubs` | 1,358 / 1,238 | 67,150 / 61,850 | 35 / 35 | ~0.05 % |
| `match-topshot-players` | 29 | 26,980 | **0** | 0 % |
| `wallet-backfill-multicollection-dispatch` | 20,194 | 20,194 | **0** | 0 % |

⛔ **DO NOT TURN THIS INTO AN ARM. Most of these are correct, and I checked rather than assumed.**

- **`snapshot-pack-asks` — the top row by a factor of twelve — is a FALSE POSITIVE, and instructively
  so.** Its `rows_found` is **2,974 on every run**: the size of the currently-listed pack set, not a
  scan. It is a delta snapshot that writes only what changed (`new: 0, changed: 7, dropped: 0`), runs
  in ~3 s, and 24 M is just 2,974 × 8,147. **Working exactly as designed.**
- **`wallet-backfill-multicollection-dispatch`** finds exactly 1 per run — it is a dispatcher; writing
  nothing is its job.
- **`pack-events-ingest-backfill`** reports `caught_up: true` with a block range, so `rows_found` is
  blocks, not rows.
- **`pinnacle-listings-retry` is CORRECT and its counter is not.** Checked rather than assumed: its
  claim already excludes retired rows (`.lt("retry_count", RETRY_COUNT_CAP)`), and the queue has in
  fact drained — `listing_resolution_failures` holds **141 rows, all unresolved and all at
  retry_count ≥ 10**, so they are retired by design and the recent runs find 3–5, not 34. But
  `rows_written` counts only ONE of its two write paths (the `cached_listings_v2.edition_id`
  backfill) and not the other (marking the failure row resolved), so a run that resolves three
  failures still reports **0 written**. ⚠ That is the null-instrument shape again, one field over:
  the pipeline lands in every zero-yield sweep forever while working correctly. ⓘ Noticed in passing
  and NOT chased: **86,796 of 134,501 `source='direct'` rows in `cached_listings_v2` carry a NULL
  `edition_id`** against only 141 recorded failures — either the failures table tracks one narrow
  event path or there is a coverage gap. **Do not read that as a defect without establishing which**,
  and it is a different subsystem from this filing.
- **`match-topshot-players`** is already known-issues **#54** (a daily no-op needing a product
  decision, not a fix).

⭐ **THE TRANSFERABLE POINT: `rows_found` DOES NOT MEAN THE SAME THING TWICE.** Across these nine it
variously means rows scanned, the size of a live set, blocks traversed, dispatches issued, and
candidates examined. **A fleet-wide yield ratio is therefore a triage list a human reads, never a
threshold a machine fires on** — an arm built on it would page on `snapshot-pack-asks` forever and be
switched off, taking the two real findings with it.

The same sweep at a 24 h window listed 15 pipelines and was even noisier, for the same reason.
**Where it earns its keep is as the FIRST step of a per-pipeline read**, which is how tonight's two
real treadmills (`sales-counterparty-backfill` and `topshot-buyer-backfill-historical`) were found.
