# ⛔ The Cowork pass's "do NOT materialise the underpriced board" reverses #39 on a null that is RANGE-RESTRICTED — the two intervals that actually got near-zero reads ran 122 ms under MEDIAN load

**2026-08-28 21:1x PT / 2026-08-29 04:2xZ · Claude Code (Trevor's box), re-deriving a Cowork cloud finding rather than filing it**
**Instrument: `public.audit_20260828_underpriced_board_cost` (jobid 373, `*/10`), read live 04:2xZ — 91 non-empty intervals, the whole table, vs the handoff's 84.**

---

## Why this filing exists

The 2026-08-28 Cowork cloud pass filed a finding concluding **⛔ "Do not ship a materialized view on the public underpriced-serials board."** That conclusion **directly reverses known-issues #39**, whose entry — written the same day, from 105 samples — reads:

> ✅ **So this item's escalation condition is MET as written: the snapshot cache (or option 3), not a shorter warm interval.**

Two analyses of the *same instrument*, opposite calls. This re-derives it. ⭐ **The Cowork measurement is sound and its covariate is a real contribution. The INFERENCE from it does not hold.**

## What the Cowork pass got right, and it is worth keeping

It added a **load covariate the audit table does not carry** (concurrent `cron.job_run_details` busy-seconds) and extended the series into the quiet band. Its numbers reproduce: latency tracks concurrent instance load far better than it tracks the board's own reads/call. I am not disputing r = +0.698 vs +0.089, and I did not re-derive them — **I tested the inference, not the arithmetic.**

## 🚨 The defect in the inference: the null is computed where reads/call never goes near zero

Bucketing all 91 intervals by reads/call:

| reads/call | intervals | calls | p50 ms/call | mean ms/call |
|---|---:|---:|---:|---:|
| **< 50** | **2** | **2** | **135** | **135** |
| 50–150 | 1 | 2 | 1,990 | 1,990 |
| 150–300 | 12 | 18 | 3,162 | 3,221 |
| 300–450 | 57 | 79 | 2,751 | 3,420 |
| 450+ | 19 | 25 | 2,181 | 4,336 |

**76 of 91 intervals sit between 300 and 650 reads/call.** Across that band, reads/call genuinely does not predict latency — which is exactly the r = 0.089 the handoff reports, and it is a correct description of the observed range.

⭐ **But an MV does not move the board along that range. It moves it to the `< 50` bucket — and the `< 50` bucket is 135 ms against a 2,181–3,420 ms neighbourhood.** A linear correlation fitted where reads/call is always large cannot say anything about reads/call ≈ 0. That is a range-restriction error, and it is the whole distance between the two conclusions.

## ⭐ The positive control: both low-read intervals are in the BUSY band, at median load

The obvious objection to a 2-interval bucket is that those two were simply quiet moments. They were not:

| interval (UTC) | reads/call | ms/call | concurrent cron busy-s |
|---|---:|---:|---:|
| **08-28 17:40** | **22** | **122** | **430** |
| **08-28 22:10** | **31** | **148** | **326** |

Both are inside the busy 14–23Z band, and **430 busy-seconds is precisely the busy band's own p50** (the handoff's figure). ⭐ **The single lowest-read interval in the busy band is also the single fastest interval in the busy band — 122 ms against that band's 3,702 ms median, a 30× gap, at median contention.** That is the control the handoff's analysis had no way to produce, because it fitted a line instead of looking at the tail it needed.

## The structure is MULTIPLICATIVE, which is why a linear fit reads null

Splitting the same 91 intervals by band and computing cost **per disk read**:

| band | n | p50 reads/call | p50 ms/call | **p50 ms per disk read** |
|---|---:|---:|---:|---:|
| BUSY 14–23Z | 58 | 353 | 3,702 | **10.215** |
| QUIET 00–13Z | 33 | **405** | **689** | **1.587** |

⭐⭐ **The quiet band does MORE reads per call (405 vs 353) and is 5.4× faster.** Load does not add latency, it **prices** it: the same read costs 10.2 ms busy and 1.59 ms quiet.

> **latency ≈ (disk reads) × (per-read cost, set by contention)**

Both terms are real. The handoff measured that the *price* term dominates the observed variance and concluded the *quantity* term does not matter. In a product, that does not follow — and the quantity term is **the only one of the two the board controls.** An MV drives it toward zero at every price.

## 👉 What this means for the decision

⛔ **Do not reverse #39 on the Cowork finding.** Its escalation condition stays MET, on its own 105-sample evidence, now with a mechanism attached rather than a correlation.

⭐ **The handoff's redirect to known-issues #42 (cron waste) is still worth taking — just not INSTEAD of #39.** Cutting instance-wide cron waste lowers the per-read price for every query on the box; the MV lowers this board's read quantity. They are complementary, and the handoff's own framing ("the same variable from the read path and the write path") is the reason to do both, not the reason to drop one.

## Honest limits — stated before anyone has to ask

1. ⚠ **n = 2 in the `< 50` bucket, two calls. Small probes CLASSIFY, they do not RATE.** This supports *"the near-zero-read regime is fast even under load"*; it supports **no figure** for how fast an MV would be. #39 already carries the relevant number from a different instrument (option 3's refresh measured **35.7 ms warm**) — that is the one to quote, not 122 ms.
2. ⚠ **I cannot say WHY those two intervals read so little.** The likely mechanism is a preceding call leaving buffers warm — **which is the state an MV manufactures deliberately and permanently**, so the mechanism supports the conclusion rather than confounding it. But it is an inference, not a measurement.
3. ⚠ **The band split is a proxy for load**, inheriting the handoff's own caveat that contention and cron busy-seconds are mutually reinforcing. The per-disk-read table does not depend on the direction of that causation; the busy/quiet labelling does.
4. **Population differs slightly from the handoff's** (91 intervals to 04:2xZ vs 84 to 03:00Z) — same instrument, mine is a superset. Nothing here turns on the extra 7.
5. ⛔ **This filing does not itself justify BUILDING the MV.** #39 is Trevor's call, on a public pricing surface, and it stays his. This only removes a reason to un-make a decision already recorded.

## Reproduce

```sql
with d as (
  select at, calls-lag(calls) over (order by at) dc,
         total_ms-lag(total_ms) over (order by at) dms,
         disk_reads-lag(disk_reads) over (order by at) dr
  from public.audit_20260828_underpriced_board_cost
), i as (select at, dms::numeric/dc ms, dr::numeric/dc rpc,
                dms::numeric/nullif(dr,0) ms_per_read from d where dc > 0)
select case when extract(hour from at) between 14 and 23 then 'BUSY' else 'QUIET' end band,
       count(*) n,
       round(percentile_cont(0.5) within group (order by rpc))          p50_reads,
       round(percentile_cont(0.5) within group (order by ms))           p50_ms,
       round(percentile_cont(0.5) within group (order by ms_per_read),3) p50_ms_per_read
from i group by 1;
```

⚠ **jobid 373 self-unschedules after 2026-08-30 00:00Z** — after that this table stops growing and the query above becomes a fixed historical read.
