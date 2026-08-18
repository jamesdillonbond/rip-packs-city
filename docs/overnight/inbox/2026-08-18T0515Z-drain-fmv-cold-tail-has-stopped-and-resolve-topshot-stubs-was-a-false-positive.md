# `drain-fmv-cold-tail` has STOPPED — and the other "genuine miss" was a false positive

**Filed 2026-08-18T0515Z (2026-08-17 22:15 PT) · Cowork cloud · READ-ONLY**
**Re-measured and CORRECTED 2026-08-17 22:38 PT (Claude Code, Trevor's box) — the stall is confirmed and stronger; the stated MECHANISM is refuted. See §Mechanism.**

Answering the open question from the blast-radius note: *"worth deciding whether those two are real
before wiring an alarm to them — otherwise it fires on arrival."* **They are not the same. One is
real, one already ticked.**

## ✅ `resolve-topshot-stubs` — NOT a miss. It ran.

Measured **21 minutes ago**, `136 runs / 136 ok` in 72h. The 104-minute reading was taken mid-gap in a
bursty cadence. **An alarm wired to it on that evidence would have fired on a healthy pipeline** — the
membership-flap problem, caught before it was wired rather than after. Nothing to do.

⚠ **Re-measured 22:38 PT: still healthy — ticked 30 min ago, `127 runs / 127 ok`.** (The counts differ
from 136/136 only because the 72h window slid; both reads are 100% ok. Dated sample, not a change.)

## ⛔ `drain-fmv-cold-tail` — genuinely stalled, unmonitored, and it is an FMV pipeline

**164 minutes silent against a metronomic 30-minute cadence.** Three independent reads over ~70
minutes: **114 → 126 → 163/164 min**, monotonically increasing. That is a distribution, not a
snapshot.

⚠ **Fourth read, 22:38 PT, independent session and box: 172 min.** Still monotonic. **This now EXCEEDS
the pipeline's own 72h maximum gap of 150 min** — the silence is outside anything in its recent
history, which is a stronger statement than the original note could make.

| measure (72h) | value |
|---|---|
| median gap | **30.0 min** |
| p95 gap | 76.5 min |
| max gap | 150.0 min |
| samples | 110 |
| **silent now (22:38 PT)** | **172 min — beyond the 72h max** |
| rule A threshold (2.5 × median) | 75 → **fires** |
| rule B threshold (max(2.5×med, 1.5×p95, 15)) | 115 → **fires** |

✅ **Every figure in this table re-derived independently and matched exactly** (n=110, median 30.0,
p95 76.5, max 150.0).

The last 14 gaps were `30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 120, 30` — metronomic apart from
one 120-minute hole, then the final run, then nothing.

**It stopped mid-work, not at a terminus.** The last run found and wrote **102 rows** (`stale 13 ·
no_data 71 · ask_only 14`) — re-verified exactly. ⚠ **This is NOT the `topshot-flowty-*` "complete,
not broken" pattern**, where the producer cursor sat at its terminus. There is real work outstanding.

⚠ **CORRECTION — the original "the backlog was growing (up from 24 and 4)" is cherry-picked.** Those
two runs are the immediate predecessors, but the wider `rows_found` series is noisy and NOT trending
up: `214, 118, 55, 4, 24, 102` (72h mean 9, max 214). 102 is well below its own recent maximum. **The
load-bearing point survives — it stopped with work outstanding — but "growing backlog" does not.**

### Mechanism — ⛔ REFUTED (was: inferred from a 4-sample baseline)

**The original hypothesis was:** the final run took **40,439 ms** against 4.7 / 5.9 / 6.9 / 11.4 s for
the runs before it — *"the first to cross ~30 s"* — and cron-job.org's documented per-job cap is 30 s,
so the drain grew past its caller's timeout and the caller stopped firing.

**The 40,439 ms figure is exact. The inference from it is wrong.** It was drawn from the four
immediately preceding runs; against the full 72h distribution it does not hold:

- ⛔ **It was not the first to cross 30 s — it was the 18th.** 18 of 111 runs exceeded 30 s in 72h,
  **max 96,714 ms**, p95 41,543 ms, mean 16,517 ms. The pipeline crossed 30 s routinely and **kept
  ticking every time**.
- ⛔ **Crossing 30 s does not predict a long gap — the control runs the other way.** Gap *after* a
  >30 s run: n=17, median 30, p95 66, **max 90**. Gap after a ≤30 s run: n=93, median 30, p95 72,
  **max 150**. Slow runs are followed by *shorter* silences than fast ones.

⚠ **First attempt at this control was itself wrong and is recorded so nobody repeats it:** filtering
`duration_ms > 30000` *before* `lead(started_at)` makes the window function step to the next SLOW run,
so it reports "gaps" of 330/480/720 min that are not gaps at all. **The filter must go in an outer
query, or the partition must span every run.**

**So the mechanism is UNKNOWN, not merely unverified.** A 30 s caller cap is affirmatively
inconsistent with the evidence. Candidates not yet tested: caller disabled/deleted, an auth or quota
failure at the caller (which would leave no `pipeline_runs` row at all — see *a tick that never
started writes no row*), or a caller this repo does not reference. **What would discriminate:** the
job's execution history in the cron-job.org console — ⛔ still not opened, its job-edit DOM carries
Authorization headers.

### Why it matters

Accuracy is the gate, and this drains the FMV **cold tail** — the low-confidence editions. A stalled
drain means the cold tail stops being worked while real rows wait. **Nothing is watching it**: its
watchlist row is `is_active = false`, marked retired.

## What this settles about the derivation change

- **The "fires on arrival" objection is half-refuted and half-confirmed, and the half that confirms is
  the useful one:** it would fire on `drain-fmv-cold-tail` **because that is a real stall nobody
  caught**, and it would NOT fire on `resolve-topshot-stubs`. That is the monitor working, not noise.
- ⚠ **Rule B costs ~40 minutes of detection latency here** (115 vs 75 min). Both catch it, so this is a
  latency trade, not a blindness one — **but the p95 term is calibrated off a window that already
  contains the fault it is meant to detect.** A pipeline that has been failing intermittently teaches
  the threshold to tolerate its own failures. Worth stating in whatever ships.
- The suppression argument stands unchanged: derivation re-adds the two correctly-retired
  `topshot-flowty-*` pipelines, so the curated list must survive as a suppression list.

## Recommended order

1. **Decide `drain-fmv-cold-tail` first** — restart or retire it. Wiring an alarm to a known-broken
   pipeline just makes it page about something already known. Needs `RPC_ADMIN_TOKEN` (operator).
   ⚠ **The restart is now un-diagnosed** — with the 30 s theory dead, a restart tests whether it
   recovers but does not explain the stop, and it may re-stall.
2. Then ship the derivation with rule B + suppression. Its first firing should be a surprise, not a
   backlog.

## Durable lesson

⚠ **A baseline of the last few runs is not a distribution.** "First to cross 30 s" was true of the
4-sample neighbourhood and false of the 111-run window — and it produced a confident, specific,
wrong mechanism with a documented vendor limit attached to make it sound measured. **A named vendor
threshold that matches your number is the most persuasive form this error takes.** Pair every
"first/only/never" claim with the count over the full window before writing it down.

**No changes made.** Read-only pass; no DB, migration, cron or code change.
