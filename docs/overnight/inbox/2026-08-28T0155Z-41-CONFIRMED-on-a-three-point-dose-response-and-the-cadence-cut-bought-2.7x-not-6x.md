# ✅ #41 CONFIRMED on a **three-point dose–response**, its confound ruled out — and the cadence cut bought **2.7×, not 6×**

**Filed 2026-08-27 18:55 PT (2026-08-28 01:55Z) by Claude Code, cloud session (push-capable).**
Closes **open reading #3** from the 2026-08-27 handoff (*"#41's falsifier — p50 of jobid 235 over a
quiet 24 h"*). ⛔ **NOTHING SHIPPED** — no schedule change. The recommendation in §5 is stated, not taken.

---

## 1. ⛔ The falsifier as written could not have answered the question

The handoff asked for *"one quiet-window p50 read"*. **A 24 h read on this job is four runs.**
Measured: 3 succeeded (p50 231 s), 1 failed at 600 s. **n = 4 is a snapshot, and #41 is a directional
claim** — CLAUDE.md's own rule is that a directional claim needs a distribution. So the stated
falsifier was run, found insufficient, and replaced with the series.

⚠ **And the obvious wider read is a trap too.** A naive pre/post split at the cut date buckets
**260 "pre-cut" runs at 18.7/day — where `*/2` predicts 12.** There were **three** schedules in this
window, not two, and mixing the first two corrupts every rate computed from them. Found by reading
runs-per-day before computing anything, per *"compare against the series' own history"*.

## 2. The series, split by actual regime

| regime | runs | fail % | **p50 (ok)** | p90 (ok) | busy h/week |
|---|---:|---:|---:|---:|---:|
| **A — `*/1`** 08-02→08-08 | 168 | 7.1 % | **52.5 s** | 348.8 s | **8.03** |
| **B — `*/2`** 08-10→08-15 | 70 | **2.9 %** | **113.4 s** | 484.3 s | **5.17** |
| **C — `*/6`** 08-16→now | 49 | **28.6 %** | **318.8 s** | 481.5 s | **2.99** |

## 3. ✅ #41's mechanism is CONFIRMED, and far more strongly than it claimed

#41 said *"a `REFRESH … CONCURRENTLY` costs what CHANGED, so tripling the interval triples the
delta"* and supported it with two points (p50 67 s → 346 s) under a **named confound**
(index-build saturation, n = 19).

⭐ **The p50 now tracks the interval almost exactly, across three points:**

| interval | 1 h | 2 h | 6 h |
|---|---:|---:|---:|
| p50 | 52.5 s | 113.4 s | 318.8 s |
| **× vs the 1 h regime** | 1.0× | **2.16×** | **6.07×** |

**A 6× interval costs 6.07× per run.** That is a dose–response, not a correlation, and it is
essentially perfectly linear. ✅ **The saturation confound is ruled out** — the effect persists over
**12 days and 49 runs** and reproduces at an intermediate dose that #41 never measured.
✅ #41's own p50 figures (67 → 346 s) land in the same place as mine (52.5 → 318.8 s).

## 4. 🚨 What the cut actually bought, and what it cost

**Bought: 2.7×, not 6×.** Busy time went **8.03 → 2.99 h/week** while run count fell 6×, because each
run got ~6× more expensive. ⭐ **Cutting the cadence of a `CONCURRENTLY` refresh cannot save
proportionally to the run count, by the very mechanism above** — and the shape of the curve
(8.03 → 5.17 → 2.99) says the next halving buys even less.

**Cost: a ~10× worse failure rate.** **2.9 % at `*/2` → 28.6 % at `*/6`.** p90 is effectively pinned
just under the ceiling in both B and C (484 s / 481 s against 600 s), so at `*/6` the job now runs
routinely close to its budget and **a quarter of its runs die there**. Per #41, each failure costs
~12 h of staleness on one point of a four-month chart.

⚠ **NOT CLAIMED — the failure rate is NOT monotonic and I cannot explain regime A.** `*/1` failed at
**7.1 %**, worse than `*/2`'s 2.9 %, despite runs less than half as long. That ordering is the
opposite of the duration story, and early August is exactly when #41's index-build saturation was
live. **So the p50 dose–response is the solid finding; A's failure rate is not explained here, and
anyone using this table should not read the fail-% column as a clean function of interval.**

## 5. 👉 The recommendation (stated, not taken)

**On this evidence `*/2` is the optimum of the three** — the lowest failure rate measured (2.9 %) at
5.17 h/week, i.e. it already captured **57 % of the total achievable saving for 10 % of the failure
rate.** Going on to `*/6` bought a further 2.18 h/week and multiplied failures by ten.

⛔ **Not shipped.** Changing a pg_cron schedule is a production state change, this job belongs to the
workstream that cut it, and §4's caveat means the fail-% column is not clean enough to make a
one-way-door argument from. ⚠ **Note also that `*/2` versus `*/6` interacts with #42's
schedule-alignment finding** — `*/6` lands on hours divisible by 3, the cohort #42 measures as
carrying 72 % of all timeout waste — so the two findings should be reconciled before either is acted
on.

⭐ **One thing worth noting against #42, though: its ordering does not reproduce here.** #42's control
(jobid 211) had **00:35Z best at 97 %**; jobid 235's four slots read **00 h 81 %, 06 h 88 %,
12 h 73 %, 18 h 92 %** — midnight is not best, and 18 h is. **The hour effect is real for 211 and is
not a constant across jobs.**

## 6. Revert path

Docs only.
