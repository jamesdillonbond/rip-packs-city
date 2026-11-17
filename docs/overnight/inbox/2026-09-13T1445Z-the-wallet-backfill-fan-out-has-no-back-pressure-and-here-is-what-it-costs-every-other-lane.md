# The wallet-backfill fan-out has no back-pressure — and here is the measurement the open item asked for: **11 of 11 unrelated lanes are slower when it is ≥10 deep, none faster**

*Claude Code (cloud), 2026-09-13 07:4x PT. **READ-ONLY — nothing shipped, deliberately; the fix is a design change to a fire-and-forget fan-out and it is not mine to make at 07:45 with Trevor asleep.** This is the measurement [2026-09-13T0800Z](2026-09-13T0800Z-seeded-wallet-stats-runs-seventeen-deep-and-is-a-top-tier-consumer.md) explicitly deferred.*

---

## 0. Why this exists

That filing fixed the backstop freshness window and closed its section with the part it did not address:

> ⚠ **Still NOT addressed, and it is the deeper shape:** `dispatchPaced` pacing on a 202 means the orchestrator has **no real back-pressure** — its `DISPATCH_BATCH_SIZE = 6` bounds dispatches in flight, not work in flight. … That is a design question about fire-and-forget fan-out, and **it wants its own measurement of what concurrency the instance can actually absorb.**

I arrived at the same place from the opposite direction and without looking for it: a `CREATE INDEX CONCURRENTLY` on an **empty** partition blew the 60 s PostgREST window because CIC waits on `Lock / virtualxid` behind whatever transactions are open, and `wallet-backfill` runs reach **610 s**. ⭐ **That is a consequence nobody has recorded: the fan-out does not merely slow the fleet, it blocks DDL for as long as its longest run.**

## 1. What concurrency the instance absorbs — the number that was asked for

`wallet-backfill*` runs, last 6 h, bucketed by how many siblings were in flight at each run's own start:

| siblings at start | runs | **p50** | p95 | max |
|---|---:|---:|---:|---:|
| 1–4 | 48 | **771 ms** | 200.2 s | 228.7 s |
| 5–9 | 103 | **1,043 ms** | 301.9 s | 363.9 s |
| 10–19 | 126 | **1,600 ms** | 340.4 s | 470.8 s |
| 20+ | 794 | **67,634 ms** | 296.9 s | 613.6 s |

⭐ **The median holds under 2 s all the way to 19 concurrent and then jumps ~42×.** That is the shape of a resource cliff, not a gradual slope — and it is the p50, not the tail, that moves.

⚠ **This alone does not establish causation, and the direction is genuinely ambiguous here:** a slow run stays in flight longer and therefore *raises the concurrency its neighbours observe*. Concurrency and duration are mutually causal in this bucketing. Section 2 is the half that is not.

## 2. The externalised cost — and it is controlled for lane mix

Same 6 h, **excluding** `wallet-backfill*` and heartbeats, bucketed by wallet-backfill concurrency at each run's start:

| wb concurrency | other-lane runs | distinct lanes | p50 | p95 |
|---|---:|---:|---:|---:|
| idle (0) | 2,932 | 141 | **2,992 ms** | 55.1 s |
| 1–9 | 161 | 47 | **12,220 ms** | 110.3 s |
| 10–19 | 30 | 17 | **23,198 ms** | 129.7 s |
| 20+ | 96 | 43 | **58,170 ms** | 205.2 s |

⛔ **Taken alone that table is confounded — 141 lanes in the baseline vs 43 in the busy bucket, so it could be reporting that slower LANES happen to run during waves.** So the same question was asked of **each lane against itself**, keeping only lanes with ≥3 runs in both conditions:

| lane | p50 when wb idle | p50 when wb ≥10 | ratio |
|---|---:|---:|---:|
| `pinnacle-trades-indexer` | 427 ms | 46,520 ms | **108.9×** |
| `wmc-fmv-populate` | 625 ms | 50,624 ms | **81.0×** |
| `pinnacle-listings-retry` | 220 ms | 12,356 ms | 56.2× |
| `allday-listings-indexer` | 2,496 ms | 96,290 ms | 38.6× |
| `promote_unmapped_sales` | 61 ms | 1,629 ms | 26.7× |
| `panini-ingest` | 1,556 ms | 32,179 ms | 20.7× |
| `ingest-pinnacle-mints-backfill` | 8,071 ms | 114,377 ms | 14.2× |
| `snapshot-pack-asks` | 3,583 ms | 33,900 ms | 9.5× |
| `pinnacle-nft-resolver` | 7,327 ms | 52,680 ms | 7.2× |
| `sales-counterparty-backfill` | 14,935 ms | 87,380 ms | 5.9× |
| `fmv-recalc` | 69,138 ms | 124,067 ms | 1.8× |

⭐ **11 of 11 slower. Not one faster.** As a sign test that is p ≈ 0.0005, and because each lane is its own control, lane mix cannot explain it.

⭐ **`pinnacle-nft-resolver` and `fmv-recalc` are the two lanes the 06:2x PT focus note named as the spell's largest contributors.** They are in this table as *victims*, at 7.2× and 1.8×. That does not exonerate them, but it does mean the attribution in that note is at best incomplete.

## 3. ⚠ The number NOT to quote, and why

Classifying whole PT hours as wave (≥100 wb runs) or quiet over **30 h** — coarser, but immune to the instantaneous-overlap objection entirely:

| hour class | other-lane runs | lanes | p50 | p95 |
|---|---:|---:|---:|---:|
| quiet | 9,448 | 155 | **4,004 ms** | 60.3 s |
| wave | 3,794 | 132 | **7,364 ms** | 109.0 s |

**p50 1.84×, p95 1.81×.** ⛔ **So the honest fleet-level figure is ~1.8×, NOT the 19× from §2 or the 100× from a single lane.** They answer different questions — *"how much slower is the fleet during a wave hour"* (1.8×, diluted by the quiet minutes inside a wave hour) versus *"how much slower is a lane that starts while ≥10 backfills are in flight"* (much more). **Quoting §2's ratios as fleet impact would be the pooling error this register keeps paying for.** The 1.8× replicates across 30 h and 132–155 lanes, so it is the robust one; §2 is the one that localises the cost.

## 4. What is established, and what is not

**Established:** the knee sits between 10–19 and 20+ concurrent · every unrelated lane measured is slower under wave load, each against itself · the fleet-level median cost is ~1.8× · long wallet-backfill transactions block `CREATE INDEX CONCURRENTLY` for their full duration.

⛔ **NOT established:** that the fan-out *causes* the spell rather than co-occurring with it. Waves fire on a schedule, and other heavy work may share those hours. The per-lane control removes lane mix; it does not remove time-of-day. **The clean test is an intervention** — cap in-flight work for one wave and re-measure the same lanes — which is a change, not an observation.

⛔ **Also not established:** what cap is right. §1 says the instance absorbs ~19 concurrent with a sub-2 s median, but that is one 6 h sample on a 2-core instance during a spell, and it is the mutually-causal measure. **Do not turn "19" into a constant** — this file's own §3 is the warning about which of its numbers travel.

## 5. Why nothing was shipped

The fix is real back-pressure in a fire-and-forget fan-out: `dispatchPaced` awaits a **202**, so the orchestrator cannot see work in flight, and giving it that sight means either a completion signal, a claim/lease table, or a concurrency semaphore. **That is a design decision with a failure mode worse than the problem** — a back-pressure bug stalls the platform's largest lane silently — and it sits beside the standing rule that an exploratory query is itself production load here. ⭐ **I tripped that rule while writing this: a 30 h per-row correlated-subquery version of §3 timed out the MCP at 60 s and had to be re-shaped into the cheap hour-classified form above.** The measurement is the deliverable; the intervention is Trevor's call.

**Suggested order:** (1) decide whether a cap is wanted at all, given the 12 h cadence already halved the wave count; (2) if yes, the cheap version is a per-wave in-flight ceiling enforced by the orchestrator reading `pipeline_runs` for unfinished siblings, not a smaller `DISPATCH_BATCH_SIZE`, which bounds the wrong thing; (3) re-run §2's per-lane table after one capped wave — it is the ready-made before/after, and every lane is its own control.
