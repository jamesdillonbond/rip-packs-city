# The drift sweep's own falsifier refutes the 07:1xZ filing — and the cutoff is a STAIRCASE, not a ramp

**2026-08-31 09:20Z (02:20 PT) · cloud pass · measurement only, nothing changed**

## What was claimed, twice, from n=1

| filing | reading | conclusion |
|---|---|---|
| ledger 2026-08-30 | `last_cutoff` +7.66 min in ~65 s | *"NOT a defect — duty-cycle-limited, and it is winning … net positive, ~1.3×"* |
| inbox 2026-08-31T0715Z | `last_cutoff` +0.510 s in 347 s | *"0.15 % of real time … the safety net … never will"* → raised a decision for Trevor |

⭐ **Both windows contained exactly ONE run of `refresh_wmc_fmv_drift_active`.** The 07:1xZ window
(07:01:10.322 → 07:06:57.327) straddles the tick at **07:03:25Z**, and nothing else. Counted from
`pipeline_runs`, not inferred.

## The measurement, 23 runs wide

All four readings are `now()` from the DB, never a container clock.

| DB `now()` | `rwfd_state.last_cutoff` | backlog |
|---|---|---:|
| 07:06:57.327Z | 03:28:12.381 | 218.14 min |
| 09:01:13.543Z | 05:56:26.574 | 184.78 min |
| 09:04:31.518Z | 05:56:27.170 | 188.07 min |
| 09:18:27.627Z | 05:56:27.635 | 202.00 min |

- **07:06:57 → 09:18:27 — 8,895.25 s of cutoff advance against 7,890.30 s of wall clock = 1.128× real time.**
- **07:06:57 → 09:01:13 — 1.297×**, which reproduces the 08-30 entry's *"~1.3×"* independently.
- Over that span: **23 runs, 11 of them wrote rows, 2,370 rows written.** Not *"2 of the last 12 ticks."*

**The 07:1xZ filing is refuted. The sweep is winning, and no decision is owed.**

## The mechanism neither filing had

`last_cutoff` is `MIN(computed_at)` over the **undrained residue**, so it does not ramp — it **climbs a
staircase**. Measured tread: **+1.06 s across 1,034 s** (09:01→09:18), during which the backlog *rises 1:1 with
the clock* because `backlog = now() − cutoff`. Then the residue clears and the cutoff jumps hours.

Consequences, in order of how much they will save the next reader:

1. ⛔ **Two `last_cutoff` reads are not an instrument at any spacing below ~20 runs.** Anything shorter samples
   one step of a heavy-tailed staircase. Both prior filings did exactly this — *including the one whose 1.3 %
   answer turned out to be right.* Being right from a bad instrument is luck, not evidence.
2. 👉 **The instrument that works is the BACKLOG TREND over hours.** Record the (now, cutoff) PAIR each pass and
   compare across passes; never quote a delta between two reads inside one pass.
3. ⚠ **A single reading can also be right and useless.** The 09:04 reading (backlog *grew* 3.3 min in 3.4 min)
   and the 09:01 reading (backlog *fell* 33.4 min in 114 min) are both accurate and point opposite ways.

## What is still true from the 07:1xZ filing

Its cost figures stand and are worth keeping: `refresh_wmc_fmv_drift_active` is the instance's #1 disk-read
consumer in a pgss diff (47 calls, 1,465,152 blocks, **31,173 blocks/call**, over 05:06→09:0xZ), every tick exits
on its 15 s deadline rather than on an empty queue, and the build has no upper bound. Its **option 3** — give the
drain a bounded upper edge per run (`computed_at > v_cutoff AND <= v_cutoff + N minutes`) — remains the right
work, because it would flatten the staircase into a constant advance and make the cost predictable.

⛔ **But it is an OPTIMISATION, not a fix, and it should not be presented to Trevor as a decision he owes.** The
measured system drains faster than arrivals.

**Falsifier for THIS filing:** four readings ≥ 30 min apart whose backlog trend is flat or rising over ≥ 4 h.
