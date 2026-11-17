> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# The AllDay pull drain's premise expired: it now costs ~7% of all instance disk reads to resolve ~63 rows a day, and the backlog it is nibbling at clears in ~50 years

**Filed 2026-08-31 05:1xZ (2026-08-30 22:1x PT), cloud pass.** DB `now()` read from the database, not the container clock.
**Repo read at `origin/main` `93591e81`, fetched 05:00Z** (the concurrent Claude Code session committed it at 04:58:48Z — 49 s before this pass started).

---

## What is expensive

`public.get_allday_unresolved_pulls(p_limit integer)` — `LANGUAGE sql`, SECDEF — is the instance's largest
**read-per-call** consumer.

Measured **through the function**, not the body (the rule from item 13):

```
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.get_allday_unresolved_pulls(300);
  Function Scan  (actual rows=300)
  Buffers: shared hit=7413 read=121276, temp read=21754 written=21824
  Execution Time: 9457.578 ms
```

**121,276 blocks read from disk = 948 MB, per call.** Plus a ~170 MB temp spill.

`pg_stat_statements` diffed on `(userid, dbid, toplevel, queryid)` against the `audit_20260830_pgss_snap`
row at **01:02:49Z**, window ending **05:06:44Z**: **8 calls, 1,023,403 blocks read → 127,925 blocks
(1.0 GB) per call**, and **~6.9% of every disk read the instance did in that window**
(1,023,403 of 14,868,262, after subtracting the two `EXPLAIN ANALYZE` probes this pass ran itself — the raw
ratio including them reads 8.38%, and is not the number to quote).

Caller: **pg_cron jobid 22 `rpc-allday-resolve-pull-editions` (`9,39 * * * *`)** → the ungitted edge function
`resolve-allday-pull-editions`. 48 calls/day ≈ **45 GB/day of cold reads** on the instance whose dominant
failure mode is disk-IO throttling.

The plan, for the record — the sort is **not** the cost:

```
Limit
 -> Gather Merge -> Sort (top-N heapsort, Memory: 63kB)
      -> Parallel Hash Join  (actual rows=577,338 loops=2)   Batches: 16   temp written 8,304
           -> Parallel Seq Scan on pack_rips        1,408,128 x2   read 96,750 blocks (756 MB)
           -> Parallel Seq Scan on allday_pack_pull   577,338 x2   read 24,367 blocks (190 MB)
```

Two full heap scans and a 16-batch hash spill, to hand back 300 rows.

## ⛔ It is NOT the item-13 param-blind class — tested, refuted

The obvious hypothesis was item 13: a `LANGUAGE sql` RPC planned generically on PG 17, fixed by
plpgsql + `SET plan_cache_mode = force_custom_plan`. **It is not.**

| form | exec | shared read |
|---|---|---|
| through the function (generic plan) | 9,457 ms | 121,276 |
| body with a literal `LIMIT 300` (custom plan) | 8,054 ms | 121,117 |

Within 15%. The generic and custom plans **agree**; item 13's 25× signature does not appear.
**Do not apply the force_custom_plan pattern here** — it buys nothing, and this entry is the measurement
so nobody re-derives it.

## Why the premise expired

`allday_pack_pull`: **1,449,546 rows, 1,154,677 unresolved (79.7%)**.

**1,154,676 of those 1,154,677 were sealed before 2026-01-01.** Exactly **one** is 2026-or-newer, sealed
04:33Z tonight. By month:

| sealed | pulls | unresolved | % |
|---|---|---|---|
| 2026-08 | 2,105 | 1 | 0.0 |
| 2026-07 … 2026-01 | 213,683 | **0** | **0.0** |
| 2025-12 | 45,842 | 30,204 | 65.9 |
| 2025-11 | 52,816 | 41,666 | 78.9 |
| 2025-10 | 56,396 | 45,138 | 80.0 |

There is a hard cliff at 2026-01-01: **everything newer is fully resolved; everything older is ~80% unresolved**,
back to the oldest row, 2024-08-05.

**Attribution, by the ledger's own free method** (jobid 22 fires at `:09` and `:39`, so the resolution minute
carries it — 2026-08-13): over 7 days, **351 resolutions at minute :09, 87 at :39, and ZERO at any other
minute.** The drain is still the sole resolver — the 08-13 finding re-confirmed, not assumed.

**Rate: 438 resolutions / 7 days = 62.6/day.** Against 1,154,676 rows that is **~50 years to clear**, at
roughly **730 MB of cold disk read per row resolved**.

⚠ **And what the drain is actually handed:** of the 300 rows it returns right now, **exactly 1 was sealed in
the last 7 days**; the rest run back to **2024-09-27**. 299 of 300 slots per tick are historical rows it will
almost certainly not resolve this tick.

## ⛔ Two prescriptions already refuted in this repo — do not re-suggest either

1. **An index.** `idx_pack_rips_collection_block_height` was built and reverted **in the same session** on
   2026-08-13 (`20260813172005` → `20260813173127`). Measured then: the nested loop it enabled blew a 50 s
   statement_timeout against the seq scan's 11.2 s mean, because the newest rips have no unresolved pull and
   the loop cannot stop early. That reasoning is **stronger now**, not weaker — the frontier is cleaner.
2. **Dropping `ORDER BY r.block_height DESC`.** Corrected in the ledger 2026-08-13, and it still stands.
   The DESC ordering is the only reason the one new arrival reaches the batch at all — my own measurement is
   the confirmation: 1 of 300 returned rows is recent, and it is there *because* of that ORDER BY.

## The lever that remains is SCOPE, and it is Trevor's call

The query is expensive because it must rank **1.15M frozen historical rows** to surface roughly one new one.
Splitting the two legs makes the frontier almost free:

- **frontier leg** — `WHERE p.sealed_at > now() - interval 'N days'` → index-servable, near-zero cost, and it
  keeps 2026 at 0.0% unresolved, which is the behaviour anyone actually depends on.
- **backlog leg** — a separate resumable cursor drain, **or** an explicit decision to stop paying for it.

**The question that needs answering: is the pre-2026 AllDay pull backlog worth draining at all?**
At today's rate it clears in ~50 years while costing ~45 GB/day. If **yes**, it needs a real resumable drain —
62.6 rows/day says the current one is not that. If **no**, time-bound the query and reclaim ~7% of instance reads.

⚠ **Deliberately NOT shipped tonight.** The fix changes *what the pipeline does* — which rows it will ever
resolve — so a DB-only time-bound would silently abandon 1.15M rows, exactly the silent scope change this
repo's rules forbid. The caller is an **ungitted edge function** a cloud session can neither deploy nor commit.
And the backlog question is a product decision, not a night-pass edit.

ⓘ Minor, for whenever the function is next rewritten: `opener_address IS NOT NULL` in the WHERE clause is
dead — the plan's filter line reads `Filter: (edition_id IS NULL)` only. Not worth a migration on its own.
