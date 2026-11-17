# ⛔ jobid 211's "three slots that have never worked" worked 100% six weeks ago — the decay is 100 → 86 → 57 → 19 → 0 → 7%, and deleting them destroys the cleanest saturation-trend instrument on the instance

**2026-08-28 21:1x PT / 2026-08-29 04:2xZ · Claude Code (Trevor's box), re-deriving a Cowork cloud proposal before passing it to Trevor**
**Live `cron.job` + full retained `cron.job_run_details` for jobid 211, read 04:2xZ. Schedule confirmed `35 */6 * * *`, `cron_heavy`, active.**

---

## The proposal, and the premise it rests on

The 2026-08-28 Cowork cloud pass queued a decision for Trevor: change `rpc-refresh-allday-pack-realized` from `35 */6 * * *` to **`35 0 * * *`**, deleting the 06/12/18:35Z slots. Its stated basis, from an **8-day** window:

> 06:35Z 0 of 7 · 12:35Z 1 of 6 · 18:35Z 0 of 8 — **"Every hour except 00 is 1 of 24. Hour 00 is 7 of 7."**
> **"The proposal: delete the three slots that have never worked."** *"It costs zero freshness."*

⭐ **The 8-day numbers are right. "Never worked" is wrong, and it inverts what the job is telling us.**

## 🚨 Over the full retained population the "dead" slots run 41–53%

`cron.job_run_details` retains back to **2026-07-20** — ~39 runs per slot, not 7:

| slot (UTC) | runs | ok | **ok %** | avg s | max s |
|---|---:|---:|---:|---:|---:|
| **00:35** | 39 | 38 | **97.4%** | 102 | 600 |
| 06:35 | 38 | 19 | **50.0%** | 337 | 603 |
| 12:35 | 38 | 20 | **52.6%** | 366 | 600 |
| 18:35 | 39 | 16 | **41.0%** | 424 | 601 |
| 08/14/20:35 *(the reverted experiment)* | 3 | 0 | 0% | 605 | 614 |

⭐ **This reconciles a disagreement that looked like a contradiction.** known-issues #42's slot table (00:35Z **97% ok** vs **42–54%** elsewhere) is reproduced here almost exactly — and the ledger's 2026-08-28 correction says that table "is untouched and still stands." The Cowork 8-day read appeared to refute it. **Neither is wrong: they are two windows on a moving quantity, and only one of them is the population.**

## ⭐ THE FINDING: it is a monotonic six-week decay, and hour 00 is the control

Weekly, non-00 slots pooled, against hour 00 in the same week:

| week of | hour 00 | non-00 runs | non-00 ok | **non-00 ok %** |
|---|---|---:|---:|---:|
| 2026-07-20 | 6 / 6 | 20 | 20 | **100%** |
| 2026-07-27 | 7 / 7 | 21 | 18 | **86%** |
| 2026-08-03 | 7 / 7 | 21 | 12 | **57%** |
| 2026-08-10 | 7 / 7 | 21 | 4 | **19%** |
| 2026-08-17 | 5 / 6 | 20 | 0 | **0%** |
| 2026-08-24 | 6 / 6 | 15 | 1 | **7%** |

**100 → 86 → 57 → 19 → 0 → 7, monotonic but for the last step, while the 00:35Z control holds at 97–100% throughout.**

⭐ **jobid 211 is an accidental dosimeter, and a remarkably clean one.** It is a single-statement, fixed-cost, fixed-schedule job that fires at four fixed hours against a hard 600 s ceiling — so its pass/fail is close to a pure readout of whether the instance had 600 seconds of headroom at that hour. The 00:35Z arm is a built-in negative control that says the *job* did not change. **Very little else on this box has that shape.**

## 👉 Two consequences, both of which cut against the proposal

**1. "It costs zero freshness" is true today and buries the fact that the freshness was already lost.** The MV was refreshed ~**4×/day in July** and is refreshed ~**1×/day now**. That degradation happened silently over six weeks — no alert, no ledger entry, and `rows_written` cannot see it because the failing runs write nothing. Making the cadence `35 0` would not *cause* a freshness loss; it would **ratify one that nobody decided to take** and remove the evidence that it happened.

**2. Deleting the slots burns the thermometer.** The handoff names this itself — *"the three dead runs are also a free retry and a free sensor"* — and then prices the sensor at roughly nothing because the slots look permanently dead. **On six weeks of data they are not dead, they are dying**, and the rate of dying is the most legible measurement of instance saturation trend currently available. ⭐ That is worth considerably more than 1,800 s/day of a resource whose *scarcity is the very thing the sensor measures*.

## Recommendation

⛔ **Do not take the `35 0 * * *` change** — not because the reclaim is not real (it is: ~1,800 s/day, ~23% of 24 h cron waste), but because it is the wrong 1,800 seconds to reclaim. **#42's inventory has waste that carries no diagnostic signal; spend that first.**

✅ **Do record jobid 211's weekly non-00 success rate as a named saturation-trend metric.** It is one query, it needs no new instrument, and it back-fills six weeks of history the moment it is written down. **If it reaches a stable 0% and stays there for two weeks, the delete becomes defensible** — at that point the sensor really has stopped reporting, and the slots really are dead.

## Honest limits

1. ⚠ **`cron.job_run_details` retention bounds this at 2026-07-20.** The 100% first week is the oldest data retained, not the beginning of the series — the decay may have started earlier and it certainly did not start at 100%.
2. ⚠ **Six weekly points described, not a fitted trend.** I have not shown *what* consumed the daytime headroom, only that it went. ⛔ Do not quote "monotonic decay" as a rate or extrapolate a date from it.
3. ⚠ **The 2026-08-24 week is a MIXED population** — its 15 non-00 runs include the 3 ticks of the reverted 08/14/20:35 slot experiment (0 of 3). Excluding them the week is 1 of 12, which does not change the reading but is not the same denominator as the weeks above it.
4. ⚠ **The pass/fail readout is a proxy for headroom, not a measurement of it.** A change in the MV's own delta size would move this line too; I have not ruled that out, and `refresh_allday_pack_realized` is `REFRESH … CONCURRENTLY`, whose cost is delta-proportional — ⭐ **which, note, cuts the same way: if the job got heavier rather than the box getting busier, cutting to one refresh a day makes each remaining run strictly harder.** Either mechanism argues against the proposal.
5. ⛔ **Nothing here re-opens the slot MOVE.** That is closed, correctly, and #42 already says not to re-propose it. This is only about the DELETE.

## Reproduce

```sql
select date_trunc('week', start_time)::date wk,
       count(*) filter (where extract(hour from start_time) = 0)                            h00_runs,
       count(*) filter (where extract(hour from start_time) = 0 and status = 'succeeded')   h00_ok,
       count(*) filter (where extract(hour from start_time) <> 0)                           other_runs,
       count(*) filter (where extract(hour from start_time) <> 0 and status = 'succeeded')  other_ok
from cron.job_run_details where jobid = 211 group by 1 order by 1;
```
