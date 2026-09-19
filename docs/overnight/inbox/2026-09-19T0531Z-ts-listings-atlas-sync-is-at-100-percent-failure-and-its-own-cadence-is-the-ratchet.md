# 🔴 `rpc-ts-listings-atlas-sync` is at 100% failure, has written nothing for 35 minutes, and its own `*/2` cadence is now the ratchet holding it there — 2026-09-19T05:31Z (10:31 PM PT 09-18)

*Cowork cloud, 10:31 PM PT 09-18. **READ-ONLY — nothing shipped into this lane.** This is an **escalation of an item another session already owns** (its 02:45Z filing, "IO saturation since ~6:30 PM PT … the Atlas listing lane times out on 9 of 12 ticks"), not a new claim on it. It is filed because the condition has moved from 9/12 to **14/14** and because `detect_stalled_pipelines()` is firing on it right now.*

## 📏 Measured, 22:28–22:31 PT

- **`detect_stalled_pipelines()` returns it**: `ts-listings-atlas-sync`, `silent_minutes` **33** against `max_silent_minutes` **20**, `classification: no_marker`, severity medium.
- **Every tick from 22:02 to 22:26 PT failed — 13 consecutive, then 14/14 for the 22:00 half-hour** — all `canceling statement due to statement timeout`, all at **120.0 s** (the lane's ceiling), avg **121.9 s**.
- **`ts_listings` newest `ingested_at` = 21:55:00 PT — 35.7 minutes stale**, frozen at 69,111 rows. The lane has produced **zero** rows in that window.

### The evening escalation, in 30-minute buckets (PT, 15 runs each)

| bucket | fail % | avg s |
|---|---|---|
| 13:30–15:00 | **0** | 9.2–16.8 |
| 15:30 / 16:00 | 27 / 20 | 46.7 / 63.8 |
| 16:30–18:00 | **0** | 13.4–28.2 |
| 18:30 | 27 | 64.3 |
| 19:00 | 87 | 114.9 |
| 19:30 / 20:00 | 53 / 33 | 98.6 / 69.4 |
| 20:30 / 21:00 | 73 / 80 | 107.0 / 111.5 |
| 21:30 | 47 | 84.9 |
| **22:00** | **100** | **121.9** |

## ⭐ THE RATCHET — this is the part the earlier filing does not state, and it is arithmetic, not a theory

The lane is scheduled **every 2 minutes** and each failing tick burns its **full 120 s** ceiling. **That is a ~100 % duty cycle: the lane occupies the box continuously while producing nothing.** Its own retries are now the load that prevents its own success, so it **cannot recover on its own even after the original trigger passes** — and the measured history says the original trigger is not the point:

⛔ **This lane has never been healthy at `*/2`.** The 01:30Z filing measured it across seven days and found **no quiet hour at all — 7.2–55.2 % timeouts in *every* hour-of-day at 25–85 s average**. A job whose average is 25–85 s against a 120 s ceiling, dispatched every 120 s, **has no headroom by construction**. Tonight is that structure meeting a loaded box, not a new fault.

📏 **Scale, for sizing:** across the last 45 minutes this lane accounted for **36.6 busy-minutes of 45** — 81 % occupancy, the estate's single largest consumer, and **flat against the prior 135 minutes (ratio 0.98)**, i.e. it is not spiking, it is simply always on. The 01:30Z filing independently put it at **57.5 % of all pg_cron statement-timeout failures**.

## 👉 THE OBVIOUS INTERVENTION — specified, costed, and deliberately NOT TAKEN

Widening the cadence cannot make the output worse, because **the output is currently zero**:

```sql
-- as the job's owner; check cron.job.username first, as this estate's jobs do not share one
select cron.alter_job(<jobid of rpc-ts-listings-atlas-sync>, schedule => '*/6 * * * *');
-- revert: schedule => '*/2 * * * *'
```

Duty cycle **~100 % → ~33 %**, returning roughly two thirds of this lane's IO to the estate. When the box is calm the lane completes in **9–17 s**, so at `*/6` it would still be finishing in a tenth of its window.

⛔ **NOT SHIPPED, and the reason is not caution for its own sake: the cadence of this lane is a PRODUCT decision, not a maintenance one.** `*/2` versus `*/6` is how fresh the Top Shot listings board is — 2-minute versus 6-minute listing latency on a surface users read for underpriced moments. That is Trevor's call in the same way R103's confidence bound and R107's refresh window are. **The maintenance argument is unambiguous; the product argument is not mine to make.**

⚠ **A second reason, stated rather than buried: I cannot fully exonerate my own probes for the tail of this window.** The R109 probes (a 321 MB index-only scan with sustained random heap I/O against `wallet_moments_cache`) ran **21:57–22:10 PT**, overlapping the 22:00 bucket. ✅ **They are not the cause** — the lane was already at **87 % at 19:00 PT and 80 % at 21:00 PT**, hours and minutes before the first probe — but they plausibly contributed to the last stretch, and **an observer who is part of the measurement should not also be the one who acts on it.**

## ⛔ Explicitly NOT claimed

- **No cause is asserted for the 18:30 PT onset.** The 02:45Z filing already looked for a single hog and found none; nothing here contradicts that.
- **R109 does not explain this lane.** That finding is visibility-map rot on `wallet_moments_cache` (85.8 % all-visible); this lane reads `topshot_atlas_market_events`, which measures **99.7 %**. Different table, different mechanism. Do not merge them.
- **No claim that tonight is worse than the 7-day norm in kind** — only in degree, and the degree (100 % for a full half-hour, 35.7 min of zero output, the stalled-pipeline arm firing) is what makes it worth an entry.

## 🔬 Falsifier / what to read first next pass

1. `ts_listings`' `max(ingested_at)` — if it has advanced, the lane self-recovered and this is a transient after all.
2. The same 30-minute bucket table. **Split on 22:31 PT** if anything is changed, and on **21:57 PT** if you are trying to attribute the tail to the R109 probes.
3. **No-change control if the cadence is widened:** `rpc-allday-unmapped-atlas-resolver` (`4-59/5`, untouched, same 689 MB table per R108). If *it* improves by the same margin, the improvement is the estate calming down, not the cadence change.
