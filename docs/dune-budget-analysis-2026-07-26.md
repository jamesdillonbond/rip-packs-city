# Dune budget — why the month burns in a day, measured

2026-07-26. Every number here is from `pipeline_runs` and `sales_counterparty_recovered` on production, not estimated.

## First, a terminology check that changes where you look

The failing call says **datapoint** limit, not credits:

> `HTTP 402: "This api request would exceed your configured datapoint limit per billing cycle."`

On 2026-07-19 the same thing happened while **credits sat at ~900 of 2,500** — comfortable. If you're reading the credits gauge on dune.com it will look fine while the thing that actually stops you is exhausted. **Datapoints ≈ rows returned** (times columns, depending on plan accounting), so the lever is *rows*, not query count.

## What the month actually bought

The cycle appears to have reset around 2026-07-24 00:00 UTC. Both lanes ran, then both 402'd by 06:11. That burst is the entire month's spend and it is fully logged.

**Ingest lane (`sales-ingest-dune`), all successful runs — 37 windows:**

| outcome | rows | share |
|---|---|---|
| `inserted` (new sales created) | 7,104 | 1.1% |
| `filled` (counterparties completed) | 55,292 | 8.7% |
| **useful subtotal** | **62,396** | **9.8%** |
| `skipped_existing` (already had it) | 56,926 | 8.9% |
| **`skipped_unresolved` (nft_id not in `moments`)** | **517,553** | **81.3%** |
| **total rows returned** | **≈636,956** | |

**90.2% of every datapoint bought a row that was immediately discarded.** The dominant term is `skipped_unresolved`: Dune returns the whole on-chain Top Shot sale feed for each window, and RPC drops any row whose `nft_id` isn't in `moments` (571,292 rows). That is not a Dune problem and no Dune-side tuning fixes it — **you are paying to discover sales for moments the catalogue has never indexed.**

Cost of a useful row: **≈10.2 datapoints each**.

## The bigger lever: the walk order is backwards relative to value

Pre-2026 seller coverage, i.e. where the gaps actually are:

| year | seller coverage | RPC rows |
|---|---|---|
| 2020 | **0.0%** | 92,613 |
| 2021 | **0.0%** | 166,141 |
| 2022 | 3.2% | 748,205 |
| 2023 | 5.0% | 1,208,416 |
| 2024 | 19.7% | 804,473 |
| 2025 | 37.5% | 739,044 |

The cursor walks **backward from 2025-12-31**. So the month's entire budget was spent on windows in **2025-06 → 2025-11** — the *best-covered* year in the table, where `skipped_existing` is highest and marginal value is lowest. The 0%-coverage years are reached last.

**Good news, and it is time-sensitive:** the ingest cursor now sits at **`cursor_end = 2022-01-01`** (`floor_date` 2019-01-01, `window_days` 2). Its next successful window is `2021-12-30..2022-01-01` — i.e. **it is now poised exactly on the 0%-coverage era.** The next cap refill is the most valuable one this lane will ever get. Nothing should move that cursor before then.

**The seller-recovery lane is not so positioned:** `cursor_end = 2025-10-24`. Left alone, it will spend the next refill on 2025 again — the 37.5%-covered year.

## Correction to something I told you earlier

I previously repeated that `sales-seller-recovery-dune` "fills 0 rows." **That is not supported, and I should not have asserted it.** The lane's telemetry records only `drained`, `query_id`, `duration_ms`, `last_window`, `windows_done` — **it has no rows-filled metric at all.** It never reported zero; it reports nothing.

Measured independently via `sales_counterparty_recovered` (hourly, UTC):

- baseline, free Flow-REST worker only: **~400–1,400 rows/hour**
- during the Dune burst, 01:00–04:00: **12,800 / 20,009 / 20,150 / 22,269**
- excess over baseline across the burst: **≈71,000 rows**

The ingest lane self-reported `filled: 55,292` in the same window, which leaves roughly **15,700 rows attributable to seller-recovery across its 43 windows** — about **365/window**, against the ingest lane's ≈1,495 useful writes/window.

So the honest statement is: **seller-recovery is roughly 4× less efficient per datapoint than ingest, and the two compete for one cap** — not that it does nothing.

⚠ **I cannot separate them cleanly, and neither can you.** `sales_counterparty_recovered` has columns `sale_id, seller_address, buyer_address, recovered_at` — **no source column.** Three writers land rows there and none tags them. The attribution above is arithmetic on an hourly baseline, which is good enough to rank the lanes but not to audit them. Adding a `source` column is the fix.

## Options, in value order

**1. Re-point the seller-recovery cursor at the 0%-coverage era (one row, reversible).**
`UPDATE sales_seller_recovery_state SET cursor_end = '2022-01-01' WHERE id = 1;` (current value `2025-10-24` — record it for revert.)
This makes both lanes spend the next refill on 2020–2021 where coverage is 0.0%, instead of re-mining 2025 at 37.5%.
**I did not do this.** It is a backfill-priority decision, not a mechanical fix: it skips 2022→2025 for seller recovery, and those years have real gaps too (3.2%–37.5%). That is your call, and it is the highest-leverage single change available.

**2. Stop paying for unresolvable rows — improve `moments` coverage first.**
81.3% of spend is `skipped_unresolved`. Until the moment catalogue covers those nft_ids, that fraction is structural and *no* budget increase fixes it. Expanding `moments` is free (Flow REST) and multiplies the value of every future datapoint. **This is the change with the largest long-run effect and it costs nothing.**

**3. Add a per-cycle budget guard in the routes.**
Both lanes drain flat-out until the API refuses. A `MAX_WINDOWS_PER_CYCLE` (or a datapoint counter persisted in the state table) would spread the same cap across the month instead of spending it in six hours. Same total throughput, but continuous progress, no 34 failed invocations/day for the remaining ~29 days, and the failure log stays meaningful. Code change → handoff.

**4. Add a `source` column to `sales_counterparty_recovered`.**
Without it, no one can say which lane earned its keep — which is exactly the argument we just had to settle with arithmetic. Cheap, and it makes option 1 measurable next cycle.

**5. Leave the schedules alone.** They fail fast (~650 ms), cost ~22 s of compute a day, park the cursor safely, and resume automatically. Deleting them risks nobody re-enabling them. They are 34 of 130 daily pipeline failures (26% of failure volume) but raise no alert.

## What I would not do

**Don't raise the Dune limit yet.** At 9.8% useful yield, buying more datapoints buys ~90% waste at the same ratio. Fix the walk order (1) and the `moments` gap (2) first — both are free — then re-measure the yield. If yield rises to, say, 40%, the same money goes four times further and the spend decision is a different one.

## Remaining drain, for scale

Ingest has `cursor_end` 2022-01-01 → `floor_date` 2019-01-01 at 2-day windows ≈ **548 windows remaining**. At the observed ~17,200 rows/window that is ≈**9.4M rows** — except per-window volume will *rise* sharply as the cursor enters the 2021 boom, when on-chain Top Shot volume was far above 2025's. A fixed monthly cap walking into rising volume means progress decelerates. Treat "finish the backfill" as a multi-quarter proposition at the current shape, or change the shape.
