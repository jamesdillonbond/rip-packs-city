# `sales-counterparty-backfill` is PERMANENTLY EXHAUSTED, its cursor cannot advance, and it rescans both `sales` partitions 286 times a day to discard every row — 47% of those ticks die on `statement timeout`

> ## ⛔⛔ CORRECTED 2026-09-12 12:3x PT — THE HEADLINE IS WRONG IN THE ONE WAY THAT MATTERS: THIS LANE IS **STUCK**, NOT EXHAUSTED
>
> **Read this before acting on anything below.** The *window* is exhausted and every number in this filing checks out — I re-derived it **exhaustively** rather than by three slices: cursor 2024-04-19 to floor 2023-11-08 holds **219,498** null-seller rows, **100%** carrying one of the two excluded sources, **zero** eligible.
>
> 🚨 **But `sales_2026` holds eligible work the cursor branch can NEVER reach:** `topshot_marketplace` 4,948 · `onchain_dapper_v1` 2,883 · `onchain` 734 · `onchain_dapper_v2` 42, all with valid 64-hex hashes. Discounting `topshot_marketplace` (migration `20260902053232`: converts **zero of 480**), **~3,659 `onchain*` rows are genuinely claimable.** **So “the decodable work is finished” is false, and retiring the lane on that basis — the obvious next step from this filing — would have abandoned them.**
>
> ⛔ **This filing's “do NOT reset the cursor, it re-walks what is already done” objection also does not hold:** the claim predicate is `seller_address IS NULL`, and a resolved row **has** a seller, so a reset re-walks only UNRESOLVED rows, newest first.
>
> ⭐ **Measured:** the `cursor IS NULL` branch runs in **8,466 ms** (`shared hit=866 read=4,219`), returns 100 of **8,607** found in `sales_2026`, and leaves `sales_2025`/`2024`/`2023` **“never executed”** — an order-preserving `Append` over range-partitions stops early. The stuck branch has no exit and times out at 60 s.
>
> ✅ **Shipped `20260912192653`: cursor reset to NULL.** ⚠ The partial-index fix this filing recommends **still stands** and is still the durable one — the cursor will descend back into the exhausted zone. It was not built here because the instance read 7 active / 3 IO-wait / 9 failed cron in 30 min.

**Filed 2026-09-11 18:17 PT (Claude Code, cloud) — Trevor: "keep going until there's nothing left unresolved."** Found while triaging a lane I had flagged in passing at 15% failures this morning; it is now 47% and the cause is not what the failure string suggests.

## The numbers

**Last 24 h, `pipeline_runs`:** **286 runs, 151 ok, 135 failed (47%)**, `rows_found` **0** and `rows_written` **0** across *all* 286. Every failure is the identical string:

```
Error: claim failed: canceling statement due to statement timeout
```

⚠ **That is the POSTGRES statement timeout, not the Supabase gateway** — this estate's own rule, and it matters here because it says the CLAIM QUERY is too slow, not that an upstream is unreachable.

## The zero is CORRECT — and that is what makes this expensive rather than broken

`claim_sales_counterparty_batch(p_limit)` walks `sales` backwards from a cursor:

```sql
WHERE s.seller_address IS NULL
  AND s.collection IN ('nba_top_shot','nfl_all_day','ufc_strike')
  AND s.transaction_hash ~ '^[0-9a-f]{64}$'
  AND s.sold_at < v_cursor AND s.sold_at >= v_floor
  AND s.source IS DISTINCT FROM 'allday_studio_history_v1'
  AND s.source IS DISTINCT FROM 'ufc_studio_history_v1'
ORDER BY s.sold_at DESC LIMIT v_limit
```

Live state: `cursor_sold_at = 2024-04-19 02:32 PT`, `floor_sold_at = 2023-11-08 09:00 PT`.

⚠ **I guessed the regex was the excluder and I was wrong — measured, in the month directly below the cursor: 19,254 of 19,254 rows PASS it.** The excluder is `source`. In that same month the null-seller rows are **15,254 `allday_studio_history_v1` + 4,000 `ufc_studio_history_v1` = 19,254, i.e. 100%.**

**Sampled three widely-spaced slices across the cursor's range — 104,600 null-seller rows, ZERO eligible:**

| slice | eligible after `source` filter | total null-seller |
|---|---:|---:|
| 2023-12 | **0** | 55,415 |
| 2024-02 | **0** | 40,168 |
| 2024-04 (below cursor) | **0** | 9,017 |

⭐ **So the remaining work is structurally ineligible by design** — studio-history rows are *known-undecodable*, which is exactly what the function's own `IS DISTINCT FROM` comment intends. **The lane has finished its decodable work.** This is the `allday-price-recover` "correct zero" of #79 — with one difference that costs real money.

## Why a correct zero costs a full scan of two partitions, 286 times a day

`EXPLAIN` (no `ANALYZE`, nothing executed) on the live cursor values:

```
Limit  (cost=0.84..51.98 rows=100 width=56)
  ->  Append  (cost=0.84..83831.55 rows=163942 width=56)
        ->  Index Scan using idx_sales_2024_nullseller_soldat on sales_2024  (cost=0.42..36423.10 rows=69535)
              Index Cond: (sold_at < cursor AND sold_at >= floor)
              Filter: (transaction_hash ~ '^[0-9a-f]{64}$' AND source IS DISTINCT FROM ... AND collection = ANY (...))
        ->  Index Scan using idx_sales_2023_nullseller_soldat on sales_2023  (cost=0.42..46588.74 rows=94407)
```

🚨 **THE LIMIT'S ESTIMATE IS 51.98 AND ITS REALITY IS 83,831.** The planner believes it will satisfy `LIMIT 100` almost immediately out of 163,942 candidate rows, so it costs the plan as if it stops early. Because the true answer is **zero**, it never stops early — it drains the entire index range of **both partitions** every single tick. ⭐ **A partial index exists (`…_nullseller_soldat`) and carries the NULL-seller and `sold_at` predicates — but NOT `source`, which is the one that rejects 100% of the rows.** So the scan is index-driven and still reads everything, only to throw it all away in a post-`Filter`.

⛔ **And the cursor CANNOT advance**, because it only moves when rows are claimed. It has been pinned at 2024-04-19 and is rescanning the same exhausted range indefinitely.

## Candidate fixes — none applied, and the ordering matters

1. ⭐ **Put `source` in the index predicate** (`… WHERE seller_address IS NULL AND source NOT IN ('allday_studio_history_v1','ufc_studio_history_v1')`). The scan then finds nothing immediately instead of reading 163,942 rows. `CREATE INDEX CONCURRENTLY` is the vehicle and this estate has proven it runs via `execute_sql`. ⚠ **Verify with `EXPLAIN` that the planner would actually adopt it before building it** — and note an index build is itself heavy IO on a 2-core, 22 MB/s instance.
2. **Give the lane an EXHAUSTED state** so a drained backfill stops instead of re-deriving the same zero forever. This is the durable one.
3. ⛔ **Do NOT simply raise `floor_sold_at` to the cursor.** I worked this through and it backfires: the function self-heals a cursor *strictly below* the floor by setting the cursor to NULL, which switches it to the `cursor IS NULL` branch scanning **upward from the floor, newest-first** — i.e. it would re-walk everything above 2024-04-19 that is already done. **The obvious one-row UPDATE is the wrong fix.**

## What is NOT claimed

- ⛔ **Not claimed as the cause of today's spells.** It is a standing consumer; the acute spells have named causes elsewhere. In a fleet-wide slowdown every lane is slower, so a 47% timeout rate is partly *symptom*. What is independent of load is the plan shape: 163,942 rows read to return 0, every tick, by construction.
- ⚠ **Three sampled months are not the whole range.** They are spread across it and all read exactly 0 eligible, but a full count was not taken — deliberately, since it is the same scan that is timing out.
- ⚠ `rows_found = 0` is a self-report and this estate treats it as a null instrument. It is corroborated here by the independent slice counts, not trusted alone.

---

# ADDENDUM (2026-09-11 18:52 PT) — measured in a genuinely quiet window. The prescription holds THIS time, but an index alone would make the waste cheap without making the lane correct.

The instance went quiet again (**1 active backend — this session — 0 IO waiters, longest statement 0 s**), so the `BUFFERS` reading this filing flagged as missing was taken. `EXPLAIN (ANALYZE, BUFFERS)` on the SELECT half only; nothing was written.

```
Limit  (actual rows=0 loops=1)
  Buffers: shared hit=192758 read=2806 written=463
  ->  Index Scan using idx_sales_2024_nullseller_soldat  (actual rows=0)
        Rows Removed by Filter: 123132      Buffers: hit=104577 read=1819 written=463
  ->  Index Scan using idx_sales_2023_nullseller_soldat  (actual rows=0)
        Rows Removed by Filter:  98051      Buffers: hit=88181  read=987
Execution Time: 4324.538 ms
```

**195,564 buffers touched to return ZERO rows. 221,183 rows delivered by the index and then discarded by the post-`Filter`. 4.3 seconds on an idle instance** — and it runs **286×/day**, which is ~20 minutes/day of pure-waste scanning at the *best* case; under load it exceeds the statement budget, which is the 47% failure rate.

⭐ **So the prescription HOLDS here, and the difference from the Pinnacle case is that this one was measured before being asserted.** On jobid 355 I reasoned from a predicate's shape to what the planner "must" do and was refuted; here the plan itself shows 221,183 rows arriving and being thrown away, so moving `source` into the index predicate would genuinely stop them being delivered. ⚠ Same *shape* of claim, opposite outcome — which is exactly why the shape is not evidence and the plan is.

## ⛔ BUT AN INDEX ALONE WOULD FIX THE COST AND NOT THE LANE

**The cursor only advances when rows are claimed, and none ever are.** A perfect index makes each tick find nothing *fast* instead of finding nothing *slowly* — 286 quick no-ops a day instead of 286 expensive ones, forever, with the cursor still pinned at 2024-04-19. **The waste becomes cheap and permanent rather than expensive and permanent.**

**So the ordering is: the EXHAUSTION STATE is the fix, and the index is at best an optimisation of a lane that should not be running at all.** Recommend in this order:

1. **Give the lane a terminal/exhausted state** — when a full pass over the remaining range yields nothing, record that and stop (or drop to a weekly probe), rather than re-deriving the same zero 286 times a day.
2. **Only then**, if it must keep scanning, put `source NOT IN ('allday_studio_history_v1','ufc_studio_history_v1')` into the partial index predicate — now evidenced by the 221,183 `Rows Removed by Filter`.
3. ⛔ Still **not** raising `floor_sold_at` — the self-heal reset described above makes that actively worse.

⚠ **One caveat kept explicit:** the 4.3 s is a WARM, quiet-instance reading (`hit=192,758` vs `read=2,806` — almost entirely cache). It is a floor, not a typical cost; the 490 s-class runs happen when that cache is cold and contended, which is precisely the spell condition.
