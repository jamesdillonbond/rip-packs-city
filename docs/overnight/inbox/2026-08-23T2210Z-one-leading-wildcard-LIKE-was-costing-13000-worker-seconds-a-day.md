# ⭐ SHIPPED — one leading-wildcard `LIKE` was seq-scanning 88,086 rows 4,684 times per refresh, and it cost 13,000 worker-seconds a day

**Filed:** 2026-08-23 22:10Z (15:10 PT) · **By:** Claude Opus 5, Cowork cloud · **Status:** SHIPPED, verified, post-ship watch scheduled for 23:00Z.

## Why I looked here at all

The 2026-08-22 ledger entry that materialised three boards ends with an explicit, dated instruction:

> ⚠ Sample is small (1–3 refreshes each) and panini's two runs were 9.9 s and 68.2 s — **re-derive after a day** before quoting these.

A day had passed and nobody had. ⚠ **And the 08-21 filing that says the deals board fails ~78% of refreshes is SUPERSEDED** — that board was materialised on 08-22 and now answers in 1.98 ms. I nearly re-derived a fixed problem; the ledger grep is what stopped it.

## What the re-derive found

`jobid 353 rpc-refresh-panini-squeeze`, last 24 h — **the second-largest cron consumer on the instance**:

| metric | value |
|---|---|
| runs | 48 |
| **failed** | **9 (18.75%)** |
| avg | 271.7 s |
| max | 618.0 s |
| **worker-seconds/day** | **13,040 (3.6 h)** |
| wasted on failed runs | 3,679 s |

To rebuild a materialized view of **4,684 rows / 2,184 kB**.

⚠ Row count moved 4,680 → 4,684 across the day, but that is **not** evidence the content is static — `panini-ingest` runs **840×/day** and wrote 1,901 rows. I checked, because "I verified a COUNT, never the VALUES" is a recorded failure here. **Cutting the cadence would have genuinely staled the board — that was my first instinct and it was wrong.**

## The actual defect — `EXPLAIN` named one culprit, not the one I assumed

```
SubPlan 2  is_rookie  ->  Seq Scan on panini_card_serials  (cost 18,755)   x4,684
SubPlan 3  is_debut   ->  Index Scan                       (cost 25)       x4,684
SubPlan 5  count(*)   ->  Index Scan                       (cost 25)       x4,684
FMV lateral           ->  Index Scan                       (cost 1.69)     x4,684  <- already cheap
```

⭐ **`nft_type LIKE '%rookie card%'` is a leading-wildcard predicate no btree can serve, and the planner estimates 21,212 matches — so it abandons `idx_panini_serials_edition` and SEQ SCANS the whole 88,086-row table ONCE PER EDITION.** `is_debut` is the *same shape* and estimates 10 matches, so it keeps the index. **Two identical constructs, opposite plans, purely estimate-driven.**

I had assumed the per-edition FMV lateral — the shape I removed from three other functions today. It was the cheapest thing in the plan. ⚠ **Pattern-matching to this morning's fix would have optimised the wrong subquery.**

## The fix

Three correlated subqueries collapse into ONE grouped pass:

```sql
LEFT JOIN (SELECT edition_external_id,
                  COALESCE(bool_or(nft_type LIKE '%rookie card%'), false) AS is_rookie,
                  COALESCE(bool_or(nft_type LIKE '%debut card%'),  false) AS is_debut,
                  count(*) FILTER (WHERE last_sale_usd IS NOT NULL) AS serials_with_recorded_price
           FROM panini_card_serials GROUP BY 1) sa ON sa.edition_external_id = e.external_id
```

`EXPLAIN (ANALYZE, BUFFERS)`: **1,402 ms · shared hit=21,775 read=17,993**, `panini_card_serials` now ONE seq scan → HashAggregate. Reads per refresh **56,789 → 17,993 blocks**.

### Equivalence, proven not asserted — all 4,684 rows, ids matched 4,684/4,684

| column | diffs | verdict |
|---|---|---|
| `is_rookie` **(changed by this rewrite)** | **0** | — |
| `is_debut` **(changed by this rewrite)** | **0** | — |
| `serials_with_recorded_price` | 3 | all 3 have a serial `captured_at` AFTER the 21:48:00Z refresh |
| `fmv_usd` | 14 | byte-identical lateral in both bodies |
| 17 untouched passthrough cols | 11 | **11 of 11** have `panini_editions.updated_at` after 21:48:00Z |

Every difference is ingest drift in the comparison window. **Zero attributable to the rewrite.**

## ⛔ I introduced a security regression and caught it in verification, not from a monitor

The retired MV had `postgres | service_role`. Its replacement came out of `CREATE MATERIALIZED VIEW` with **`anon=rxm` and `authenticated=rxtm`** — Supabase's `ALTER DEFAULT PRIVILEGES` on schema `public` apply to every new relation. **Replacing an object does not inherit the original's ACL; it inherits the schema default, which is wider.**

`panini_squeeze_board` is itself NOT anon-readable, so for ~12 minutes the underlying MV was directly reachable by anon through PostgREST while the surface built on it was not. Revoked in `20260823220755`.

⛔ **`check_public_security_invariants()` returned 0 rows the whole time.** It checks RLS on base tables, `security_invoker` on views and anon EXECUTE on destructive functions — **it does not diff a replaced object's ACL against the one it replaced.** Green was not evidence.

👉 **New rule: on any object swap, capture `relacl` from the object being replaced and reapply it explicitly, then diff.**

## ⚠ What is NOT established

- **The headline is NOT "234 s → 1.4 s".** The old job was bimodal *by slot*: `:18` ran 211.5 s and 195.3 s while `:48` ran 3.5 s and 10.7 s. It already achieved 3.5 s in a quiet window. The load-independent claim is the **read count (56,789 → 17,993) and 4,684 → 1 seq scans**, not the wall clock.
- One post-ship datapoint (a manual run, 1,423 ms) in the **quietest hour on the board**. That is the warmest possible condition — the error I made on jobid 357 earlier today.
- ⭐ **The `:18` slot is therefore the real test**, and a watch is scheduled for 23:00Z covering the 22:18 and 22:48 ticks with the hourly load control read alongside.

## Migrations

`20260823220439` create v2 · `20260823220555` repoint board (+ `security_invoker` restored in the same transaction) · `20260823220648` drop old, rename v2 into place · `20260823220755` revoke the anon leak. All four md5-verified and written to `supabase/migrations/`. `refresh_panini_squeeze()` and cron 353 are UNCHANGED — the rename means the function's literal name resolves to the new MV. Revert path in the header of `20260823220648`.

---

## ✅ POST-SHIP VERIFIED 2026-08-24 02:16Z — 8/8 ticks succeeded, and there is a matched-load comparison

Eight scheduled ticks of jobid 353 since the cutover, **zero failures** (baseline: 9 of 48, 18.75%):

| tick (UTC) | secs | | tick | secs |
|---|---|---|---|---|
| 22:18 | 1.7 | | 00:18 | 3.5 |
| 22:48 | 1.5 | | 00:48 | 30.9 |
| 23:18 | 1.7 | | 01:18 | 39.8 |
| 23:48 | 1.3 | | 01:48 | 1.5 |

Max **39.8 s** against a pre-ship max of **618 s**. Rows written 4,684–4,685 throughout, `ok=true`
on every run.

### ⚠ The post-ship hours ARE the quietest in the window — so read the matched pairs, not the average

Instance-wide cron busy-seconds per hour:

| pre-ship | busy_s | panini | | post-ship | busy_s | panini |
|---|---|---|---|---|---|---|
| 14:00 | 5,433 | 245.0 | | **22:00** | **1,501** | **1.7** |
| 18:00 | 12,576 | 467.5 | | **23:00** | **1,544** | **1.7** |
| **20:00** | **2,724** | **211.5** | | **00:00** | **2,505** | **30.9** |
| **21:00** | **3,503** | **195.3** | | **01:00** | **2,829** | **39.8** |

⭐ **The two bolded pairs are like-for-like on instance load and they are the real evidence:**

- **20:00 (2,724 busy-s) → 211.5 s** vs **00:00 (2,505 busy-s) → 30.9 s** — **6.8× faster at
  slightly HIGHER ambient load.**
- **21:00 (3,503 busy-s) → 195.3 s** vs **01:00 (2,829 busy-s) → 39.8 s** — 4.9× faster, and 01:00
  carried 3 instance-wide failures and one job at the ceiling, so it was not a calm hour.

⚠ **And part of the post-ship quiet is SELF-CAUSED, which is a real effect but must not be double
counted.** Panini alone was burning ~400–600 s per hour; removing that is a visible share of the
20:00–21:00 (2,724/3,503) → 22:00–23:00 (1,501/1,544) drop. The job was a meaningful fraction of the
instance's own baseline load in quiet hours.

⛔ **NOT yet tested in a genuinely loaded hour.** Nothing in the post-ship sample approaches 18:00's
12,576 busy-seconds. The 01:00 pair is the most contended evidence available and it holds.

### Worker-seconds reclaimed

81.9 s across 8 ticks over 4 hours ≈ **20.5 s/hour ≈ 491 s/day**, against a measured baseline of
**13,040 s/day** — a **~96% reduction, roughly 3.5 worker-hours/day returned to the instance.**
⚠ Projected from a 4-hour sample that excludes the daily peak; re-derive over a full day before
quoting it.

### Correctness, re-checked after 4 hours of live refreshes

Re-measured at **02:17:20Z**, not carried over from the cutover check:
`panini_squeeze_board` **4,685 rows** · MV **4,685 rows** · `is_rookie` **1,093** ·
`check_public_security_invariants()` **0 rows** · board `security_invoker=on` ·
MV ACL still **`postgres | service_role` only** — the anon leak fixed in `20260823220755` has NOT
reappeared through 8 live refreshes (a `REFRESH ... CONCURRENTLY` does not reset an ACL, now
confirmed rather than assumed).

⚠ Row count moved 4,684 → 4,685 and rookies 1,092 → 1,093 during the window. That is `panini-ingest`
doing its job, and it is the direct evidence for the earlier point that **cutting this job's cadence
would have staled a live board** — the content genuinely moves.

---

## FINAL — 2026-08-24 23:30Z: the full-day re-derivation the section above demanded

The exit condition was explicit: *"NOT yet tested in a genuinely loaded hour"* and *"re-derive over a
full day before quoting it."* Both are now satisfiable, so this is a re-TEST of the stated condition,
not a re-read of it.

**Window: a complete 24 h, 08-23 23:00Z -> 08-24 22:59Z, 48/48 ticks.** (The 08-24 23:00Z hour is
partial and is excluded rather than annualised.)

### The headline number MOVED, and downward

| | pre-cutover (08-22 23:00Z -> 08-23 21:59Z, 46 ticks / 23 h) | post-cutover (24 h, 48 ticks) |
|---|---|---|
| job-seconds | **12,959.6** (= **13,523/day** scaled to 48 ticks) | **800.7** |
| mean per tick | 281.7 s | **16.7 s** |
| statement-timeout wall-kills | **6** | **0** |

**-> 94.1% reclaimed, ~12,700 worker-seconds/day returned.** The 4-hour projection said **491 s/day
/ 96%** and the 7.75-hour one said **538 s/day / 95.9%**; the true full-day figure is **800.7 s/day /
94.1%**. Both short samples were optimistic, because both **missed the 12:00Z and 13:00Z hours**
(127.9 s and 100.9 s — together 29% of the entire day's cost). The direction of the error is the
point: **a short window under-counts the expensive hours, so it flatters the fix.**

### The loaded-hour test, which is what was actually blocked

08-24 18:00Z ran at **11,590.1 instance busy-s** — the day's peak, and **92% of 08-23's 12,575.6**.
That gives a near-matched load pair against the pre-ship peak:

| hour | instance busy_s | panini job-s |
|---|---|---|
| 08-23 18:00Z (pre) | 12,575.6 | **530.4** |
| 08-24 18:00Z (post) | 11,590.1 | **20.5** |

**25.9x cheaper at 92% of the load.** The claim now holds at the daily peak, which is the exact
condition the previous section flagged as untested.

### The one post-cutover "failure" is NOT panini's, and the control says so

08-24 09:48Z, `job startup timeout`, 21.9 s. That is a pg_cron **launcher** failure -- the function
body never ran. Instance-wide over the same window:

| era | `job startup timeout` | distinct jobs | of which panini |
|---|---|---|---|
| pre-cutover | 217 | 40 | 3 |
| post-cutover | 110 | 32 | **1** |

Panini is 1 of 110 across 32 jobs -- a bystander in a shared, **already-characterised** condition
(see `2026-08-17T0410Z-the-pgcron-startup-timeout-is-not-a-worker-slot-cap-it-is-the-saturation.md`,
whose worker-slot hypothesis is REFUTED there; do not re-file this as new).

The failure class that was actually panini's -- `canceling statement due to statement timeout`, the
600 s wall -- went **6 -> 0**. That is the honest statement of the reliability change.

### Correctness, re-measured at 23:30Z (not carried over)

`mv_panini_squeeze` **4,694 rows** = `panini_squeeze_board` **4,694** · `is_rookie` **1,095** ·
`check_public_security_invariants()` **0 rows** · board `security_invoker=on` ·
MV acl `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`, `has_table_privilege('anon',…)`
= **false**. The 08-23 anon leak has NOT reappeared across ~50 live refreshes.

⚠ **I nearly published that ACL line off a null instrument.** The first query read
`information_schema.role_table_grants` and returned **NULL** -- which I was one step from reporting as
"clean". It is not clean, it is **blind**: that view returns **zero rows for a materialized view**.
The correct source is `pg_class.relacl` / `has_table_privilege`. That near-miss is what turned up the
missing invariant filed as `2026-08-24T2345Z-…-materialized-views.md`, and it is why the standing
monitor was green through the 08-23 leak.

### Status

✅ **CLOSED.** The exit condition is met and the number is final at **94.1% / ~12,700 s/day**.
Quote **800.7 s/day**, not 491 or 538.
