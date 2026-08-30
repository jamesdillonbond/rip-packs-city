# ⛔ GitHub Actions does not honour our schedules — 14.9% of runs start on time, and the DAILY guards run up to 12 HOURS late

**Filed 2026-08-29 ~22:30 PT (2026-08-30 05:30Z) by the Claude Code interactive session. MEASURED across all 16 scheduled workflows, 449 runs. Not a hypothesis.**

---

## How this surfaced

Chasing known-issues **#48**, whose stated experiment (`sleep 60 → 300` + `timeout-minutes 10 → 25`) had already shipped in `1de79b1a8` and whose **falsifier had never been evaluated**: *"if the backstop stays near 73% at the wider spacing, density is not the cause and the hour is — then either move it to a quiet hour … or retire it."*

Trying to evaluate that, the backstop's dispatches did not appear in its scheduled hours at all. The cron is `38 2,8,14,20 * * *`; the actual run times were 00:03, 03:29, 09:21, 13:04, 14:34, 17:52, 22:46, 23:57 …

## The measurement

Per workflow, over the last 30 **scheduled** runs (`gh run list --json createdAt,event`, `event == "schedule"`), delay = minutes from the nearest preceding cron slot.

⚠ **`gap` is the CENSORING BOUND** — minutes between consecutive slots. A delay cannot be measured above it, so a workflow running every 20 min can never *show* more than ~20 min of lateness however late it is. **Only the rows with a wide gap are safely interpretable**, which is why they are separated below.

### Uncensored (daily — gap 1440 min). These are true delays.

| workflow | n | ≤5 min | p50 | max |
|---|---:|---:|---:|---:|
| `db-pin-staleness` | 21 | **0** | 43 | **728 (12.1 h)** |
| `edge-fn-drift` | 22 | **0** | 55 | **737 (12.3 h)** |
| `snapshot-institutional-wallets-backstop` | 30 | **0** | 63 | **720 (12.0 h)** |

**0 of 73 daily runs started within 5 minutes of schedule.**

### Wide-gap, at or near the cap (so "at least a full cycle late")

| workflow | n | ≤5 min | p50 | max | gap |
|---|---:|---:|---:|---:|---:|
| `migration-parity` | 25 | 0 | 40 | 437 | 470 |
| `e2e-smoke` | 23 | **0** | 60 | 327 | 360 |
| `wallet-backfill-backstop` | 30 | **0** | 45 | 356 | 360 |
| `topshot-active-listings-ingest` | 30 | 0 | 45 | 178 | 180 |
| `badge-sync` | 30 | 0 | 66 | **198 > gap 150** | 150 |

### Censored (frequent) — reported for completeness, NOT evidence of punctuality

`pipeline-sentinel` (gap 60), `sales-indexers-backstop` (30), `allday-ingest` (20), `rpc-pipeline` (20), `pinnacle-owner-discovery` (20), `offer-fill-backfill` (15), `topshot-sales-history-backfill` (15). Their p50 of 7–13 min may simply be the largest number the metric can express. ⛔ **`ops-monitor` is UNINTERPRETABLE here** — its slots are 2 min apart, so every run reads as "near the cap"; its p50 of 18 means nothing.

**TOTAL: 449 sampled scheduled runs; 67 (14.9%) started within 5 min of schedule.**

⭐ **The pattern is monotonic and it is the wrong way round: the SPARSER the schedule, the worse the delay.** GitHub deprioritises low-frequency scheduled workflows — so the repo's careful minute-picking is applied precisely where it is honoured least.

## What this invalidates

1. **#48's remaining lever is structurally unavailable.** *"Move it to a quiet hour"* cannot be done on GHA: you cannot place a scheduled workflow in an hour band. Spacing and hour reasoning about `wallet-backfill-backstop` are both unsound. Its real options are **move the trigger to pg_cron / cron-job.org** (which the primaries already use and which do honour time) **or retire it**.
2. **The "~2h after each primary" redundancy property does not hold.** A run 356 min late on a 360-min cycle lands on top of the window it was supposed to cover, providing no redundancy at that moment.
3. **Every "minute X is GHA-empty" comment in this repo is reasoning from a false premise.** One was removed from `wallet-backfill-backstop.yml` in this pass rather than reworded.
4. 🚨 **`e2e-smoke` is the one that should worry us most.** CLAUDE.md states that with Sentry dark since 08-18, *"the scheduled `E2E DOM Smoke` badge is the ENTIRE detection surface"* for client-only failures. It starts **+60 min at p50, 0 of 23 runs on time, max a full cycle late**. The only client-error detector is materially later than its schedule implies — a live React #418 could sit unseen for hours longer than anyone assumes.
5. **`db-pin-staleness` is self-undermining**: a *staleness* check that can itself be 12 h late.

## What this does NOT claim

- ⛔ **Not that any workflow SKIPPED.** This measures start-time delay only. Shedding is a separate (also real) question — the register's note that GHA drops runs is not re-measured here.
- ⛔ **Not that the frequent workflows are punctual.** Their metric is censored; they may be just as late in relative terms.
- ⛔ **Not a new GitHub bug.** Delayed `schedule` events are documented GitHub behaviour under load. The finding is that **this repo's scheduling model assumes a precision the platform does not offer**, and now there is a number for it.

## Suggested action

1. **No emergency.** Nothing is broken by this alone; correctness does not depend on minute-level timing anywhere I checked. It is the *reasoning* that is unsound.
2. **For #48:** stop treating stagger/hour as the lever. Decide between moving the trigger to pg_cron/cron-job.org or retiring the backstop — a decision, not a diagnosis.
3. **For `e2e-smoke`:** worth Trevor knowing that the sole client-error detector is p50 +1 h. If detection latency matters, trigger it from cron-job.org like the other time-critical paths.
4. **Cheap durable guard (not shipped):** a test asserting no workflow comment claims a collision-free minute would be brittle. Better is a periodic re-run of this measurement — the script is 30 lines of `gh run list` + cron parsing and is reproduced in the ledger entry.

**Nothing shipped except the corrected header comment on `wallet-backfill-backstop.yml`.**
