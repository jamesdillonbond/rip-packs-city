# ⛔ DO NOT RUN THE `:13` STAGGER — it is harmful as written, and it is currently QUEUED as "ready-to-run"

Claude Code, interactive, 2026-08-16 15:20Z / 08:20 PT. Measured live, nothing applied from the
refuted block. **This supersedes the "Status of the actual `:13` stagger" ready-block in
[`2026-08-16T0030Z-cron-heavy-jobs-ARE-reschedulable-from-mcp-via-set-local-role.md`](2026-08-16T0030Z-cron-heavy-jobs-ARE-reschedulable-from-mcp-via-set-local-role.md).**

The 2026-08-16 overnight handoff lists that block as QUEUED item 1, described as "ready-to-run,
reversible". **An operator pasting it would degrade the instance.** The *mechanism* half of that
filing is correct and verified (see bottom); only the *stagger* it recommends is wrong.

## Three independent reasons the block is wrong

### 1. Its premise is stale — there is no three-way `:13` pile-up

The 1630Z filing that motivated it describes three heavy jobs colliding at minute 13. Live now,
minute 13 holds **one hourly job**:

| jobid | job | schedule | owner |
|---|---|---|---|
| 71 | `rpc-backfill-historical-pack-ev` | `13 * * * *` | cron_heavy |
| 109 | `rpc-refresh-special-serial-owners-mv` | `13 4,16 * * *` | cron_heavy |

Job **235 `rpc-refresh-market-index-daily` has already moved to minute 7**. So job 71 runs *alone*
at `:13` for 22 hours a day, and the only genuine collision is 2 hours a day (04:13, 16:13).

### 2. Leg one moves a lone job onto an occupied slot — strictly worse

The block sends job 71 to `40 * * * *`. Minute 40 is **not** free:

| jobid | job | schedule | avg / p95 / max runtime (7d) |
|---|---|---|---|
| 67 | `rpc-allday-cross-source-sales-dedup` | `40 * * * *` | 95.9s / 245.4s / **618.2s** |
| 19 | `rpc-allday-listing-ask-fmv` | `40 */6 * * *` | — |
| **71 (proposed)** | `rpc-backfill-historical-pack-ev` | `40 * * * *` | 149.8s / 531.1s / **610.6s** |

That trades *"alone 22 h/day"* for a **guaranteed hourly overlap of two jobs that each run up to ~10
minutes**, plus a three-way every 6 h. This is the opposite of the filing's stated goal.

### 3. Leg two lands on the job that just recovered

The block sends job 109 to `25 4,16 * * *`. Minute 25 at hour 4 already holds **jobid 4
`rpc-ccm-step2`** (avg 101.1s, max 311.0s, already 2 failures in 7 runs) — the cross-collection MV
step that the 08-16 14:46Z monitor recorded as freshly **RECOVERED** after a 44 h stale spell caused
by exactly this class of timeout. Stacking job 109's ~82–173s onto it is the likeliest way to break
it again.

## ⚠ The deeper result: start-minute staggering cannot fix this class at all

This is the part worth keeping. I measured, for every job-71 run in 24 h, how many other cron runs
were in flight simultaneously:

| job 71 runtime (s) | other cron jobs overlapping |
|---:|---:|
| 73 | 6 |
| 81 | 6 |
| 111 | 5 |
| 157 | 8 |
| 216 | 11 |
| 258 | 18 |
| 311 | 17 |
| **601** | **26** |
| **611** | **29** |

**Overlap tracks the job's own DURATION, not its start minute.** A job with a p95 of 531s spans ~9
minutes and will overlap whatever starts anywhere in that window — at `:13` it already runs
concurrently with jobs starting at :14, :17 and :19 regardless of where it begins. Minute-level
staggering is therefore cosmetic on this instance: **the schedule is oversubscribed in DURATION,
not in start minutes.**

⚠ This converges with the trust-precompute finding filed the same day
(`2026-08-16T1455Z-…`), which reached the identical conclusion from the other direction —
*"rescheduling is dead as a fix; it just chooses which legs starve."* **Two instruments, one
answer: the lever is the WORK (page size, fan-out, budget isolation), never the clock.**

## What was done instead

Nothing was applied from the refuted block. The converged structural fix — **splitting the trust
precompute into 8 independent cron jobs so each leg gets its own 600 s budget** — WAS applied and is
recorded in `supabase/migrations/20260816150800_audit_20260816_trust_precompute_split_into_8_leg_jobs.sql`
with its revert block. That fix is budget *isolation*, which the measurement above supports; it is
explicitly **not** a rescheduling fix and does not claim to reduce saturation.

## What IS correct in the 0030Z filing — keep this half

The permission mechanism is verified live and should be folded into CLAUDE.md as that filing asks:

```
postgres IS a member of cron_heavy ............... true
cron_heavy CAN execute cron.schedule ............. true
cron_heavy CANNOT execute cron.alter_job ......... true   (the pincer, confirmed)
cron_heavy rolconfig ............................. {statement_timeout=600s}
```

So `SET LOCAL ROLE cron_heavy; SELECT cron.schedule('<existing name>', …);` updates in place, keeps
the jobid, and — because the owner is set to the *current* role — retains the 600 s budget. The
`SET LOCAL ROLE` is load-bearing exactly as that filing says. **This path was used for the 8-way
split and worked**, so the mechanism is now proven in production, not just in a probe.

## Durable

**A filed fix is a hypothesis, and the cheapest possible check is whether its target slot is
occupied — one query.** This block had been reviewed enough times to be promoted to "ready-to-run,
reversible" in a handoff. "Reversible" describes the revert path; it says nothing about whether the
change is *correct*, and the two get conflated when a block is pasted rather than re-derived.
