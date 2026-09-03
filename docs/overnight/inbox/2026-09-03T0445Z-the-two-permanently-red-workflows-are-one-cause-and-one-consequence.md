# The two permanently-red workflows are one cause and one consequence — the fleet alarm is pinned CRITICAL by a condition that is deliberately unresolved

**Filed 2026-09-03 ~04:45Z (2026-09-02 PT) by Claude Code. NOTHING CHANGED — the resolution reverses
an explicitly argued decision by a prior session, so it is put here rather than shipped.**

## What the sweep found

A health pass over all 19 scheduled workflows (most recent ~30 runs each) found **no workflow that has
stopped firing** — every one has a `schedule`-event run since 2026-08-31 — and exactly two that are
permanently red:

| workflow | runs returned | conclusions | leading failure streak |
|---|---:|---|---:|
| `edge-fn-drift.yml` | 30 | **30 failure / 0 success** | **30** |
| `pipeline-sentinel.yml` | 30 | 20 failure / 10 success | **19** |

⭐ **They are not two problems. They are one.**

## The chain, read from the logs rather than the badges

**`edge-fn-drift` exits 1 BY DESIGN on any drift.** Its 2026-09-02 11:39Z run reports
`DRIFT: 5 function(s). 0 of them are safe to redeploy.` — 1 ⏸ *deferred by decision*
(`sync-nba-projections`) and 4 ⛔ *do-not-redeploy* (`compute-golazos-pack-ev`,
`ingest-allday-pack-opens`, `ingest-pinnacle-mints`, `ingest-topshot-pack-opens-history`). **Every one
carries a dated written reason and a stated clearing condition** in
`scripts/check-edge-fn-drift.mjs`. The detector is working perfectly; the condition it reports is true
and deliberately unresolved, and clearing it is operator work (R64 / R21).

**The sentinel is then red because of that.** Its 2026-09-03 00:31Z run returns a full report and
`status: CRITICAL` from **exactly one** check:

> **Detector Health (GitHub Actions)** — `critical` — *"Consecutive-failure streaks: edge-fn-drift 12x
> (warn at 3, crit at 7). A detector red for many days running is usually CORRECT and unread — read
> the LOG, not the badge."*

⭐ **The sentinel already contains the arm for the hazard, it is firing correctly, and its own detail
text states the problem in one sentence.** Nobody has connected the two badges.

## What is and is not being masked — stated precisely

In that run **no other check is `critical`.** Two are `warn` and both look like real work:

- `Pipeline Silence` — **`allday-pack-opens-backfill` silent 205m** (threshold 90m)
- `Trust Health` — **`unmapped_resolution_backlog_max = 209`**, breach at 100 (37/38 arms passing)

⚠ **So nothing is demonstrably hidden today**, and this filing does not claim it is. The harm is
structural: with the status pinned at CRITICAL every run and the badge red for 19 consecutive runs,
**a NEW critical cannot change either signal**. That is the failure mode the Detector Health arm was
written to name, now applying to the sentinel itself.

ⓘ Also visible in that payload, unrelated but confirming an open row: `notifications` reads
`["telegram", "email-FAILED:not_configured", "github-actions-native"]` — **R62's email channel is
still unconfigured**, while telegram carries no FAILED marker in this run.

## The design conflict, with both sides stated fairly

This is not an oversight. Two guards hold opposite positions and both arguments are written down.

**`check-edge-fn-drift.mjs`**, on its `DEPLOY_DEFERRED` map:
> *"⛔ It deliberately does NOT change the exit code. Drift is still drift and the check still exits 1
> — suppressing the exit is how a detector goes green while the drift stands, which is the failure
> this whole file exists to prevent."*

**The sentinel's Detector Health arm**, in effect: a detector red for many days is itself a failure,
because it is unread.

Both are right about different risks. ⚠ **The first cost is stated with no number in it; the second
now has one — 30 consecutive red runs and 19 on the alarm downstream.** This repo's standing rule is
that a filed decision not to act is a hypothesis, and that the tell is exactly a cost with no number.

## The candidate resolution — NOT taken, and why

**Exit 0 when the drifted set is a SUBSET of the two documented maps; exit 1 the moment a function
drifts that is in neither.** That never goes green on *unacknowledged* drift — it goes green only when
every drifted function has a written, dated reason and a named clearing condition, which is the state
today. It would clear the streak, un-pin the sentinel, and restore the badge's meaning to "something
NEW".

⭐ **The discriminator already exists in the report** and needs no new bookkeeping: the run prints
`0 of them are safe to redeploy`, so a sixth, unacknowledged drift shows up as `safe: 1`. **Only the
exit code and the badge conflate the two cases; the text never did.**

⛔ **Not shipped, deliberately.** It reverses another session's explicit, argued decision and it
changes alerting behaviour on the fleet alarm — the one instrument whose failure mode is silence.
That is Trevor's call.

⚠ **A cheaper half, if the full change is unwanted:** teach the Detector Health arm to exclude a
detector whose red is fully acknowledged. Same effect on the sentinel, no change to `edge-fn-drift` —
but it moves the suppression one level up rather than removing it, which is worse in one specific way:
the sentinel would then be asserting something about a script it does not read.

---

## ⛔ CORRECTION, same session, ~20 minutes later — I checked the two warns and BOTH are benign

Above I wrote that the two `warn` checks sitting under the pinned CRITICAL *"both look like real
work"*. **That was an inference from the alert text, not a measurement, and it is wrong on both.**

**`allday-pack-opens-backfill` silent 205m — SELF-CLEARED.** Its last run is **2026-09-03 03:46:02Z**,
about twenty minutes before this correction and well inside its 90-minute window. Over the 73 h
`pipeline_runs` retains: **71 runs, 65 ok, 63 wrote rows.** The 00:31Z reading was a transient gap,
not a stalled pipeline.

**The unmapped backlog — `info`, and DRAINING HARD.** `check_unmapped_backlog_growth()` returns
severity **`info`** for both collections. All Day: **outflow 4,672 against inflow 41 in 24 h**,
drain_ratio **113.95**, **net −4,631/day**, ~**9.2 days** to clear 42,590 actionable rows (of 100,009
open, the other 57,419 being multi-NFT gross rows frozen by design). UFC: 1,070 open, zero flow both
ways.

⚠ **The `Trust Health` arm's `unmapped_resolution_backlog_max = 209` is a DIFFERENT metric from the
growth checker's**, and this correction does not claim the arm is wrong — only that the backlog it
gestures at is shrinking fast, so "real work" was the wrong description.

⭐ **The finding of this filing is UNAFFECTED and is arguably strengthened.** The structural point was
never that something is currently masked — the filing says so explicitly — but that **a pinned badge
cannot signal a new critical.** Both warns being benign is exactly what a healthy fleet under a stuck
alarm looks like, and it is why *"read the LOG, not the badge"* had to be the first thing checked.

