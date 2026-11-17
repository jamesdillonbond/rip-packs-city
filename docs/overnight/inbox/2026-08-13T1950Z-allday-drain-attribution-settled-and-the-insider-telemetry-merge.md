# The AllDay drain attribution is settled (keep jobid 22), and the insider-detector telemetry can drop 12 scans to 3

Claude Code, interactive, 2026-08-13 ~12:50 PT (19:50Z). Read-only measurement + one shipped code
change. **No DB change** — both DB-side items below are filed, not taken, because a concurrent session
owns that lane today.

---

## Part 1 — the `get_allday_unresolved_pulls` attribution question is ANSWERED: do not disable jobid 22

[`2026-08-13T1845Z`](2026-08-13T1845Z-allday-pull-drain-is-a-forward-resolver-not-a-backlog-drain.md)
closed with an explicitly load-bearing unknown:

> Whether the ~90/day forward resolutions come from this job at all, or from
> `rpc-allday-nem-from-sales-backfill` (jobid 215 …). **The two are not distinguishable without item 3**,
> and that ambiguity is load-bearing for decision 1 — if the self-heal is doing the work, this job may
> already be pure waste.

**They ARE distinguishable, without instrumenting anything, because the two schedules do not collide.**
jobid 22 runs `9,39 * * * *`; jobid 215 runs `*/30` (`:00`/`:30`). Nine minutes apart, so the resolution
timestamp itself carries the attribution. `allday_pack_pull.updated_at` is stamped on resolution, and
`idx_allday_pack_pull_updated_at` makes the read cheap.

```sql
select extract(minute from updated_at)::int as minute_of_hour, count(*) as resolved
from public.allday_pack_pull
where updated_at >= now() - interval '7 days' and edition_id is not null
group by 1 order by resolved desc;
```

| minute_of_hour | resolved (7 d) |
|---:|---:|
| **39** | **444** |
| **9** | **241** |
| *(any other minute)* | **0** |

**100% of resolutions land on jobid 22's schedule. jobid 215 contributes exactly zero.** So the drain is
the *sole* resolver of `allday_pack_pull.edition_id`, the ~90/day forward resolution is real and is its,
and **decision 1 resolves to KEEP** — disabling it would stop the only thing resolving these rows. The
1845Z file's warning ("do not simply disable jobid 22") is confirmed by measurement rather than by
caution.

⚠ **A second thing falls out of the same table, and it is not conclusive on its own.** The split is
**444 at :39 vs 241 at :09**, not the ~50/50 two equal half-hourly ticks should produce. The :09 tick
yields ~54% of what :39 does, which is strikingly close to the **43 calls against ~82 scheduled (~52%)**
the 1845Z file measured. That is *consistent* with the live `pg_net_http_403` dropping roughly half of
this job's ticks, and with the :09 tick being the more-dropped one — but it is only consistent, not
proof: an unequal arrival rate of newly-resolvable pulls across the two half-hours would produce the same
shape. **Item 3 (give the edge fn a `pipeline_runs` row) is still the prerequisite to settle it** — this
narrows the question, it does not close it.

Method note worth keeping: **when two jobs are suspected of doing the same work, check whether their cron
minutes differ before building an instrument.** A schedule offset is a free attribution channel, and here
it answered in one indexed query what was filed as needing a deploy.

---

## Part 2 — `count_insider_detector_candidates`: 44.7 GB of disk reads for telemetry, and 4× of it is the same scan

Ranked #4 in the 1730Z disk-read table: **44.7 GB / 402 calls / 65.8% hit / 114 MB per call** over 39.7 h
≈ **27 GB/day**, ~3% of all disk reads on the instance.

**Shape.** `app/api/cron/run-insider-detectors` calls it `3 collections × 4 detectors = 12 times per
hourly tick`, concurrently. 402 calls over the window matches ~34 ticks × 12.

**It is pure telemetry.** `candidates_evaluated` exists only so a 0-alert run is interpretable ("no
candidates existed" vs "candidates existed but were threshold-rejected"). Nothing pages on it; grep finds
**no production consumer** outside the route and its tests.

⚠ **And 4 of every 4 calls per collection re-scan the same 24 h window.** From the committed DDL
(`20260517130000_insider_detector_candidate_count_rpc.sql`), `unusual_volume` and `floor_drops` are the
**identical query** —

```sql
SELECT edition_id FROM sales
WHERE collection_id = X AND sold_at > NOW() - INTERVAL '24 hours' AND edition_id IS NOT NULL
GROUP BY edition_id HAVING COUNT(*) >= 5   -- unusual_volume
                    HAVING COUNT(*) >= 3   -- floor_drops
```

— differing only in the `HAVING` threshold, and `concentration_buys` / `early_buyers` scan the same
window again with an extra predicate.

**Shipped now (code only, no migration):** the counts are **sampled every 6th UTC hour** instead of
hourly — 288 calls/day → 48, roughly **22 GB/day of disk reads recovered**. The question they answer
("is the market thin, or are the thresholds too tight?") moves over weeks. `INSIDER_CANDIDATE_COUNTS=always`
restores hourly counting for a diagnostic window with no deploy; `=never` disables it.
⚠ A new `candidates_status: "counted" | "failed" | "skipped"` rides alongside, because `null` already
meant "the count RPC errored" — sampling without it would have made a **broken telemetry RPC
indistinguishable from a deliberate skip**, and a partial total (one leg failed) reads as a real smaller
number, so the total is marked `failed` rather than silently under-reported.

**NOT taken — the DB half, and it is the better fix (needs `apply_migration`, hence filed):**
a single RPC returning all four counts from **one** pass over the 24 h window would cut **12 scans to 3**
while keeping *hourly* granularity, and composes with the sampling above rather than replacing it. The
two detectors above can be answered from one `GROUP BY edition_id` with two `count(*) FILTER` arms.
Whoever takes it: the counts are documented as "the OUTERMOST gating CTE, BEFORE per-tier dollar floors,
baseline ratios, or dedup" — that definition is the contract to preserve, and
`__tests__/api-cron-run-insider-detectors-deferred.test.ts` already pins the telemetry math.

⚠ **The detectors' own output cannot substitute, which is the trap to avoid here.**
`detect_unusual_edition_volume` already returns `sales_examined_24h` and it looks like the number you
want — it is not. That is raw sale **rows** in the window; `candidates_evaluated` is **distinct editions
passing the HAVING gate**. Substituting one for the other would silently change what the field means
while leaving every test green.
