# `sales-counterparty-backfill` finished its walk 40 hours ago and has been re-scanning a dead range ever since — 470 of 470 ticks, ~40 min of DB time a day, as the platform's #3 reader

**Filed 2026-09-05 05:10Z (2026-09-04 22:10 PT) · Claude Code on Trevor's box, interactive · MEASURED, NOTHING SHIPPED — the durable fix is in a Cloudflare Worker, which [never auto-deploys](../reference/tooling-gotchas.md), and the DB-side alternative changes cursor semantics. This is a decision, not a chore.**

## How it was found, which matters because every alarm is green

It is **not** on any failure list. Over 24 h it logs **`ok = true` on every run**, and it does not appear in the failed-pipeline census at all. It surfaced only from `ops_pgss_delta`, where `claim_sales_counterparty_batch` is the database's **#3 reader — 3,089,242 blocks over 301 calls in 24 h, 9,818 ms/call**.

⚠ **And its own instrument was telling the truth the whole time.** `pipeline_runs.extra` reads `{"note": "drained", "batch": 0, "duration_ms": ~10000}` on essentially every tick since 2026-09-03. Nobody read it. `ok=true` + `rows_written=0` is the null-instrument pair CLAUDE.md already names; the honest note sat one field over.

## The measurement, split at the change point rather than pooled

The state row `sales_counterparty_backfill_state` last advanced **2026-09-03 12:57:37Z** (cursor `2024-04-19 09:32:49Z`, floor `2023-11-08 17:00Z`, scanned 1,561,469 / recovered 969,271 / undecodable 592,198). Splitting the trailing 48 h there:

| window | runs | drained | productive | DB time |
|---|---:|---:|---:|---:|
| **before** the last cursor advance | 98 | **0** | **98** | 48.6 min |
| **after** it | 470 | **470** | **0** | **81.1 min** |

⭐ **That is a step change, not a decline** — 98/98 productive on one side, 470/470 drained on the other, switching exactly at the cursor's last movement. ~**40 minutes of database time a day**, all of it returning zero rows.

## Why it cannot recover on its own — two independent reasons

**1. The claim scans a range that is provably empty, and re-proves it every tick.** Running the ELSE branch's exact query at the live cursor:

```
Limit (actual rows=0 loops=1)
  Buffers: shared hit=179592 read=15972          -- 195,564 buffers, 4.9 s
  ->  Index Scan using idx_sales_2024_nullseller_soldat  Rows Removed by Filter: 123132
  ->  Index Scan using idx_sales_2023_nullseller_soldat  Rows Removed by Filter:  98051
```

**221,183 index entries walked, every one rejected** by the collection / 64-hex-tx / `source` filters. Those rows are permanently unclaimable — they are the `undecodable 592,198` population — so the scan will produce zero on every future tick too.

**2. The cursor only advances on rows it PROCESSED, so an empty claim moves nothing.** `workers/sales-counterparty-backfill/index.ts` returns early on `rows.length === 0` without calling `apply_sales_counterparty`, and the file's own header states the invariant: *"the cursor only advances past rows we actually saw."* That is correct for throttled rows (they get retried) and **wedging for exhausted ones** — there is no "reached the end of the reachable range" state.

## ⚠ "drained" is the wrong word, and the wrong word is the defect

The worker logs `note: "drained"` when **the claim returned nothing**, and that is not the same claim as **the work is complete**. Measured with the same predicate but WITHOUT the `< cursor` clause: **146 rows in the last 30 days (135 in the last 7) still match and are claimable** — newest `2026-09-05 03:22Z`.

They sit **above** the cursor, and the walk only ever looks **below** it, so they are **structurally unreachable by this pipeline**. A reader seeing "drained" concludes the backfill is finished; it is neither finished nor working.

## The two candidate fixes, and why neither was shipped tonight

- **(a) Teach the walk to terminate / turn around** — worker-side. ⛔ `workers/**` **never auto-deploys**; pushing it to `main` ships nothing, so this needs a manual `wrangler` deploy. It is also the more invasive option: making the claim fall back to the range ABOVE the cursor interacts with `apply_sales_counterparty`, which writes the cursor, and a naive version can oscillate.
- **(b) Nudge the state so the dead range stops being scanned** — DB-side and within reach, but it is a **data mutation to pipeline state with a real downside**: historical sales backfills DO insert rows into past ranges, and a cursor moved past 2023-11→2024-04 strands anything later written there.

⛔ **And explicitly NOT the fix: adding a partial index to make the dead scan cheap.** It would work — a partial index matching the full predicate returns zero instantly instead of walking 221K entries — and it is optimising a no-op. The scan should stop, not get faster.

## Falsifiers

```sql
-- 1. Is it still drained? (the whole finding collapses if productive > 0)
select started_at > '2026-09-03 12:57:37Z' as after_last_advance,
       count(*) runs,
       count(*) filter (where extra->>'note' = 'drained') as drained,
       count(*) filter (where (extra->>'batch')::int > 0)  as productive
from pipeline_runs
where pipeline = 'sales-counterparty-backfill'
  and started_at > now() - interval '48 hours' and extra ? 'batch'
group by 1;

-- 2. Has the cursor moved? (if updated_at advances, it un-wedged itself)
select * from public.sales_counterparty_backfill_state;

-- 3. Is the forward gap real and growing? (146 at filing time)
select count(*) from public.sales s
where s.seller_address is null
  and s.collection in ('nba_top_shot','nfl_all_day','ufc_strike')
  and s.transaction_hash ~ '^[0-9a-f]{64}$'
  and s.source is distinct from 'allday_studio_history_v1'
  and s.source is distinct from 'ufc_studio_history_v1'
  and s.sold_at >= now() - interval '30 days';
```

⚠ **Re-derive #3 before acting on it** — the forward trickle may be served by another lane (`sales-serial-backfill` went on-chain 2026-09-03), in which case the 146 are someone else's population and only the wasted scan is left to fix.
