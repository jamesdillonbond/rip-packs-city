# ⭐ SHIPPED — the UFC and Golazos promote legs are parked, using the function's own recheck mechanism rather than a new gate

**Filed:** 2026-08-24 03:45Z (20:45 PT) · **By:** Claude Opus 5, Cowork cloud · **Status:** SHIPPED and verified. **This closes the open decision Trevor had been carrying.**

## The decision that was waiting

Whether to skip / archive the UFC + Golazos `promote_unmapped_sales` legs. Three options were filed
on 08-23 and nothing shipped. Given decision authority, I re-derived first — and the numbers had
moved enough to matter.

## Measured, 72-hour window from `pipeline_runs`

| leg | runs | eligible | promoted | total_s |
|---|---|---|---|---|
| `nfl_all_day` | 804 | 625 | **545** | 22,817 |
| `ufc_strike` | 119 | **0** | **0** | 1,043 |
| `laliga_golazos` | 326 | **0** | **0** | 455 |

**445 runs across the two legs, zero eligible and zero promoted, ~499 s/day.**

⭐ **Stronger than the filed "0 resolved in 30 days": `max(resolved_at)` is NULL for both
collections.** Neither has ever resolved a single row in the table's history. That is not a slow
population, it is no population.

⚠ **And the filed mechanism was wrong.** The claim implied cron was running these legs. It is not —
`cron.job` has exactly one caller, jobid 215, and it passes **All Day's UUID only**. The 119 UFC and
326 Golazos runs come from outside cron (app or edge), which is why a cron change could never have
fixed this.

## Why they never resolve — all four branches are structurally empty

| | UFC (1,070 unresolved) | Golazos (9) |
|---|---|---|
| hint `edition_id` | 0 | 0 |
| hint `set_id_onchain` | 0 | 0 |
| in `nft_edition_map` | 0 | 0 |
| in `wallet_moments_cache` | 0 | 0 |

Every row passes the `price_usd > 0` guard, so all 1,079 **are** scanned in full each run and then
fail all four `EXISTS` branches. UFC has 533 `nft_edition_map` rows and 518 editions overall — the
map simply has no overlap with these `nft_id`s. **The rows lack the identifiers the resolver needs.**

## ⛔ Why not a gate, and why not a skip list

The obvious `IF eligible = 0 THEN skip` is a recorded refutation: **eligibility IS the four-branch
scan**, so the guard costs exactly what it guards. A hardcoded per-collection skip list is worse — it
welds the door shut and rots the day UFC becomes resolvable.

## ✅ What shipped instead — the function already had the answer

`promote_unmapped_sales`'s `candidates` CTE opens with

```sql
AND NOT (us.resolution_hint ? 'promote_recheck_after'
         AND (us.resolution_hint->>'promote_recheck_after')::timestamptz > now())
```

and its own `mark_blocked` arm sets that key for rows it proves un-promotable. A jsonb key test is
far cheaper than four `EXISTS` with joins and is evaluated first, so marked rows never reach the
expensive branches. **The mechanism existed; these rows had simply never been marked.**

Migration `20260824033743` marks them. ⚠ The `WHERE` **re-verifies all four branches per row** rather
than trusting the collection-level counts, so a row that could resolve is never parked. ⚠ The
`COALESCE(resolution_hint,'{}')` is load-bearing — `NULL ?| array[...]` is NULL and `NOT NULL` is
NULL, which would have silently excluded the most unresolvable rows.

**Verified after applying:** UFC 1,070/1,070 parked, Golazos 9/9, **All Day 0 parked and 105,052 still
scanned** — the leg doing the real work is untouched.

**Positive control, production function, production data:** `promote_unmapped_sales(ufc, 1000)` now
returns in **1,592 ms** against an 8,768 ms baseline average, with `eligible: 0`, `promoted: 0`
unchanged and `open_backlog: 1070` still reported. ⚠ One run, at 03:45Z which is a very quiet hour —
the structural claim is that 1,070 rows now skip four EXISTS branches, not the millisecond figure.

⭐ **It stays falsifiable.** The horizon is 30 days (the function's own convention), so the entire
population is automatically re-tested on **2026-09-23** at the cost of one normal run. Nothing is
deleted and nothing is hidden — `still_unresolved` / `open_backlog` keep counting them.

⚠ **It decays.** New UFC rows keep arriving (481 in 30 d, 15 in 7 d) without hints and will not carry
the marker, so per-run cost creeps back at ~16 rows/day against 1,070 parked. The durable version is
for the function to mark no-path rows itself. **Filed, not shipped** — that is a change to a large,
carefully-commented function and this captures ~98% of the benefit with no code change.

## 👉 The next lever this measurement surfaced — All Day, and it is much bigger

`nfl_all_day` is **22,817 s per 72 h ≈ 7,606 s/day**, roughly 15× the two legs just parked, and it is
*working* — 545 promoted. But it scans **105,088 unresolved rows to find 625 eligible: a 0.6% hit
rate**, 804 times in 72 hours. At the observed rate the backlog needs ~578 days to clear.

⚠ Note All Day is marked **SUNSET** in memory while carrying a 105k-row live backlog and actively
resolving — those two facts should be reconciled before anyone acts on either. **Not touched.** The
same `promote_recheck_after` mechanism is the obvious lever, but 105k rows deserve their own
measurement of *why* they are unresolvable before any are parked.
