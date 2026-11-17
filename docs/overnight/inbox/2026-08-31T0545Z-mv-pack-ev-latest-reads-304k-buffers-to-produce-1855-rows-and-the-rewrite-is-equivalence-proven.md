# 📏 `mv_pack_ev_latest` touches **304,034 buffers to produce 1,855 rows** — the rewrite is equivalence-proven at **17.2× fewer buffers**, and it is a DROP…CASCADE, so it is Trevor's call

**Filed:** 2026-08-30 ~22:45 PT (2026-08-31 05:45Z) · **By:** Claude Code, Trevor's box, overnight pass
**Class:** heap-fetch amplification (the 211 / 237 shape, third instance) · **Status:** MEASURED, EQUIVALENCE-PROVEN, ⛔ **NOT SHIPPED — deliberately, see §5**

---

## 1. How it was found — the new triage instrument's first real lead

`supabase/analysis/cron-waste-triage.sql` (committed tonight) ranks **jobid 73
`rpc-refresh-mv-pack-ev-latest` third in the `LIVE` class at 1,237 wasted seconds/day** — 66 failures
in 14 days, every one at the 600 s ceiling, against a best success of 597 s. Classic clipped tail.

⚠ **Tonight's watermark gate does NOT fix this** — [the 0525Z filing](2026-08-31T0525Z-the-pack-ev-watermark-gate-skips-12pct-not-50pct-because-distinct-hours-saturates.md)
measures it skipping **11.8%** of ticks, so ~88% still run the full refresh.

## 2. The measurement

The MV is **768 kB / 1,855 rows**. Its defining query is a `DISTINCT ON (pack_listing_id) … ORDER BY
pack_listing_id, snapshotted_at DESC` over `pack_ev_history` (**300,779 rows, 59 MB heap**).

```
Unique  (rows=1855)
  ->  Index Scan using idx_pack_ev_history_listing_time  (rows=165,035, Rows Removed by Filter: 135,801)
        Buffers: shared hit=304034
```

🚨 **It walks all 300,779 rows in index order and heap-fetches every one, then throws away 163,180 of
the 165,035 survivors.** The index order (`pack_listing_id`) does not match the heap order (insert
time), so those are ~300k *random* heap visits — ~1 buffer per row — to keep 1,855.

**The correct index already exists.** This is not a missing-index case; Postgres has no index
skip-scan, so `DISTINCT ON` walks the whole range regardless.

## 3. The rewrite, and the number that actually matters

Find the winning `(pack_listing_id, snapshotted_at)` pairs **index-only** on the existing
`idx_pack_ev_history_listing_covering` (which already carries `pack_ev, pack_price, pack_name` — every
filter column), then join back to the heap for **1,855 rows instead of 165,035**.

| | original | rewrite | ratio |
|---|---:|---:|---:|
| **buffers (warm)** | **304,034** | **17,682** | **17.2×** |
| time (warm) | 425 ms | 179 ms | 2.4× |
| time (cold) | 8,118 ms | 2,265 ms | 3.6× |
| plan | Index **Scan** + 165k heap visits | Index **Only** Scan, `Heap Fetches: 3,611` | — |

⚠ **A CONTROL CHANGED THE HEADLINE AND IS RECORDED RATHER THAN BURIED.** My first pair read
**8,118 ms → 2,265 ms** and I nearly published it as the result. Re-running the ORIGINAL once the pool
was warm gave **425 ms** — so that pair was **cold-vs-warm**, the exact trap CLAUDE.md names
(*"a DB A/B must be WARM-vs-WARM"*). The warm-vs-warm speedup is **2.4×, not 3.6×**.

⭐ **The buffer ratio is the robust figure — 17.2×, and it is identical cold and warm because buffers
are a work count, not a cache outcome.** On an IO-bound instance at a 22 MB/s floor that is the number
that predicts behaviour, and it is also *why the job is bimodal*: 304k buffers fits when the pool is
resident and cannot finish when it is not, which is precisely the 211 / 237 signature this repo has
now fixed twice.

## 4. ✅ Equivalence PROVEN over the population, both directions

Not "same row count" — same rows. All 20 projected columns, `EXCEPT` in both directions:

| check | result |
|---|---:|
| original rows | 1,855 |
| rewrite rows | 1,855 |
| `original EXCEPT rewrite` | **0** |
| `rewrite EXCEPT original` | **0** |
| `original INTERSECT rewrite` | **1,855** |

⚠ The outer `DISTINCT ON` in the rewrite is **load-bearing, not decoration**: two history rows can
share a `(pack_listing_id, snapshotted_at)` pair, and the join would then emit both. Do not "simplify"
it away.

## 5. ⛔ Why this was NOT shipped tonight

**A materialized view cannot be `CREATE OR REPLACE`d.** Changing its definition means
`DROP MATERIALIZED VIEW … CASCADE`, and the blast radius is enumerated, not assumed:

- **CASCADE reaches exactly two views, and nothing deeper** (recursive `pg_depend` walk, depth ≤ 5):
  `public.pack_table_rows` and `public.v_topshot_pack_market`.
- 🚨 **`v_topshot_pack_market` carries `reloptions = {security_invoker=on}`.** This repo has had that
  setting silently stripped on a view **four** separate times. Recreating it without the `WITH` clause
  reintroduces that defect on a public read surface.
- ⚠ **The two views' ACLs are NOT the same and must not be harmonised:** `v_topshot_pack_market` is
  `anon=rxm` (anon CAN select), `pack_table_rows` is `anon=xm` (anon **cannot** select). Copying one
  onto the other either breaks a surface or opens one.
- **Two indexes on the MV must be recreated**, one of them the `CONCURRENTLY` dependency:
  `mv_pack_ev_latest_pack_listing_id_uidx` (UNIQUE on `pack_listing_id`) and
  `mv_pack_ev_latest_dist_coll_idx` on `(dist_id, collection_id)`. **Miss the unique one and jobid 73
  fails forever with an error naming the view rather than the index** — which is exactly what
  `supabase/tests/mv_refresh_wrappers.sql` exists to pin.
- **Three functions reference these objects by name** and are NOT protected by `pg_depend` (plpgsql
  bodies are text): `get_pack_detail_bundle`, `get_pack_market_row`, `refresh_mv_pack_ev_latest`. The
  column list is unchanged so they should be unaffected — **verify, do not assume.**

**That is a multi-object destructive migration on a public read surface.** CLAUDE.md puts destructive
SQL outside what an autonomous pass ships, and the register's own precedent is that both comparable
changes (the 211 and 237 indexes) were **Trevor's explicit call** — and this is larger than either.

## 6. The recipe, so nobody re-derives it

⚠ **Capture the view definitions and ACLs AT SHIP TIME, not from this filing** — a pasted snapshot is
stale the moment upstream moves, which is this repo's recorded reason for preferring the derivation:

```sql
SELECT c.relname, c.relkind, c.reloptions, c.relacl::text, pg_get_viewdef(c.oid, true)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('pack_table_rows','v_topshot_pack_market');
```

Then, **in ONE transaction** (atomic: readers block on the lock rather than seeing a missing relation):

1. `DROP MATERIALIZED VIEW public.mv_pack_ev_latest CASCADE;`
2. `CREATE MATERIALIZED VIEW public.mv_pack_ev_latest AS <the §3 rewrite> WITH DATA;`
3. Recreate **both** indexes from §5 (the UNIQUE one is not optional).
4. Recreate both views from the captured definitions — **`v_topshot_pack_market` WITH
   `(security_invoker = on)`**.
5. Re-apply the captured ACLs **per object**, not a shared template.
6. Post-state assertions in the same transaction, so a miss rolls back rather than ships:
   row count = the pre-change count; the unique index exists; `reloptions` on
   `v_topshot_pack_market` still contains `security_invoker=on`; `has_table_privilege('anon', …)`
   matches the captured value for each view separately.

**Revert:** the same recipe with the original `DISTINCT ON` body from
`pg_matviews.definition` (capture it first — put it in the migration header).

👉 **Falsifier after shipping:** jobid 73 runs `3,33 * * * *`. Its next ticks should stop reaching the
600 s ceiling. ⚠ **n = 1 tick classifies, it does not rate** — and the job's failures cluster in busy
hours, so a green tick at 06:00Z proves less than a green tick at 12:35Z.

## 7. ⚠ What this does NOT claim

- **Not that the rewrite takes jobid 73 under its ceiling.** It removes 94% of the buffers the defining
  query touches; the `REFRESH … CONCURRENTLY` machinery (temp build, diff, apply) is untouched and on
  the 237 precedent that machinery was ~24 of 25 s.
- **Not a user-visible accuracy change.** §4 proves the output is identical today. It is an IO fix.
- **Not urgent.** Nothing is starved; the board is fed. This is waste, not an outage.
