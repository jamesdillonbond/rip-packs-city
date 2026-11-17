# 🚨 `ufc-sales-indexer` has ONLY the GHA backstop left — and the backstop delivers **16 of 48** scheduled runs a day. The smoke alarm is CORRECT; the trigger is broken.

**Filed 2026-08-26 ~19:5x PT (2026-08-27 02:5xZ) by Claude Code, from Trevor's box.**
Found while checking why `Smoke Tests` went red on `main`. **The alarm is right — do not silence
it.** Two findings, one of which changes the risk picture for the three LIVE sales indexers.

---

## 1. The symptom

`Smoke Tests` on `main` went from green at 02:09:45Z to **hard-fail** at 02:33:06Z and 02:40:17Z:

```
Results: 54 passed / 55 total · hard 42/43 · soft failures 0
  HARD FAIL: sales indexers running (detect_stalled_pipelines)
             — ufc-sales-indexer silent 251m (>240m)
```

Last `ufc-sales-indexer` run was **22:30:11Z**; 22:30 + 240m = 02:30Z. The crossing is exactly
on the threshold, so this is a fresh crossing, not a long-standing red.

⚠ **This is NOT caused by the commits it fails on.** It failed identically on `aadca601`
(docs-only) and on `c570d9be` (a pack-ask DB function). Read the failing job, not the commit.

## 2. ⭐ The measurement that names the cause

Cadence of all four watchlisted sales indexers over 24 h — three of them are the controls:

| pipeline | runs/24h | avg gap | max gap | silent now |
|---|---:|---:|---:|---:|
| `topshot-sales-indexer` | 85 | 16.9 m | 40.0 m | 0 m |
| `allday-sales-indexer` | 85 | 16.9 m | 40.0 m | 7 m |
| `golazos-sales-indexer` | 87 | 16.5 m | 39.0 m | 12 m |
| **`ufc-sales-indexer`** | **16** | **76.9 m** | **191.9 m** | **253 m** |

Three of four fire ~85–87×/day on a ~17-minute cadence — that is cron-job.org's 3×/hr primary,
alive and healthy. **UFC fires 16×/day.**

⭐ **And the 16 timestamps match the `Sales Indexers Backstop` GHA workflow runs exactly**
(GHA 22:30:06 → pipeline_run 22:30:11; 19:18:13 → 19:18:18; 16:58:15 → 16:58:21; …).

👉 **Reading: cron-job.org's UFC trigger is dead, and only the GHA backstop is still firing it.**
This is precisely the failure the backstop workflow's own header was written to survive:

> *cron-job.org auto-disables a job that persistently fails its 30s client cap, so a single bad
> window can silently kill sales ingest.*

UFC is chained off `/api/ufc-pipeline` (cron-job.org 18,38,58), so an auto-disable there kills the
chain. ⚠ **INFERENCE, not a direct reading.** I did not open the cron-job.org console — its bearer
token sits in that page's DOM and this repo has leaked it twice by broad-reading it. The inference
rests on three same-instrument controls at 85–87 vs one at 16, plus exact timestamp correspondence
with the surviving caller. **Whoever confirms it must read `input[type=text]`[2] only.**

## 3. 🚨 The finding that matters MORE than UFC: the backstop's stated guarantee is measured FALSE

`.github/workflows/sales-indexers-backstop.yml` is scheduled `18,48 * * * *` — **48 runs/day** —
and its header claims the safety property outright:

> *Twice hourly (**30-min max gap**) stays well under the watchlist max_silent (allday 90m /
> topshot 180m) **even if GitHub drops a scheduled run**.*

**Measured: it delivered 16 runs, avg gap 76.9 min, max gap 191.9 min.** GitHub is dropping ~2/3
of the scheduled fires (well-documented deprioritisation of `schedule` events under load). The
parenthetical "even if GitHub drops a scheduled run" budgets for ONE drop; the real rate is two in
three.

⭐ **Why this is the important half.** The backstop is the *only* safety net for
`topshot-sales-indexer`, `allday-sales-indexer` and `golazos-sales-indexer` — all HIGH/MEDIUM on
the cadence watchlist. Today they are fine because cron-job.org is alive for them. **If
cron-job.org dies for Top Shot the way it evidently has for UFC, the backstop would deliver ~77-min
average gaps against a 180 m `max_silent` — it would hold, but with far less headroom than its
header promises, and All Day's 90 m `max_silent` would be BREACHED by the measured 192 m max gap.**

**UFC is the canary that already fired.** It is the one collection where the primary is gone, so it
is the only one currently measuring what the backstop alone actually delivers — and the answer is
"not what the comment says".

## 4. ⛔ Why the UFC data impact is nil, and why that must NOT be used to silence the alarm

`ufc-sales-indexer` has found **nothing for 105 days**:

- newest `ufc_strike` sale: **2026-05-13 17:06Z**; **0 sales in 30 d, 0 in 90 d**; 813,934 total.
- Control: newest `nba_top_shot` sale is minutes old, so the `sales` table is being written and the
  instrument works.
- Every run reports `ok: true, rows_found: 0, rows_written: 0`, and
  `extra.v2_dapper_typeids_seen` has **never once contained a UFC type ID** across every run
  inspected — only TopShot / AllDay / Pinnacle / Golazos / MFLPack. Consistent with UFC Strike
  having left Flow.

⛔ **So "just widen the threshold" or "drop UFC from the smoke gate" is the wrong move**, for two
reasons. First, the alarm is reporting a REAL broken trigger, and it is currently the only
instrument that can see the backstop's true delivery rate. Second — the repo's own rule — *a
permanently-red or permanently-zero instrument is indistinguishable from a broken one*, and
silencing it converts a true positive into a blind spot on the exact mechanism protecting three
live pipelines.

## 5. 👉 What needs deciding (Trevor), and what does not

**Needs Trevor — cron-job.org console access, which no session should broad-read:**
1. Is the cron-job.org "UFC" / `/api/ufc-pipeline` entry **disabled**? If yes, that confirms §2 and
   re-enabling it restores UFC to the 17-minute cadence its three siblings enjoy.
2. **The real question underneath:** UFC Strike appears to have left Flow (0 sales/90 d). Should
   this indexer be **retired** rather than repaired? `collections.slug='ufc_strike'` is still
   `chain=flow, is_active=true` with 813,934 historical sales, so retiring it is a product call
   with surface consequences — not a cleanup. **Either answer is fine; the current state (a
   pipeline scanning ~13,000 blocks a run to find nothing, alarmed on liveness) is the one that is
   not.**

**Does NOT need Trevor, and is the part worth doing regardless:** the backstop workflow's header
states a 30-minute max-gap guarantee that is measured false. That comment is load-bearing — it is
the reason nobody has treated the backstop as fragile. It should be corrected to the measured
numbers whether or not UFC is repaired or retired.

⚠ **Re-derive before quoting.** Every figure here is a dated sample from a 24 h window on
2026-08-27; GHA's drop rate in particular is a function of GitHub's load and will move.
