> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# A ~253 MB index set sat unused behind a `NULLS LAST` clause on the public player pages

**Filed 2026-08-31 18:35Z (11:35 PT) · cloud-only pass · status: FIXED AND VERIFIED**

Destination on commit: `docs/overnight/inbox/2026-08-31T1835Z-a-253mb-index-set-sat-unused-behind-a-nulls-last-clause.md`

> ⚠ This pass could not push. The blocker is specific to **that cloud session** — Trevor's
> machine and Claude Code push normally. **Commit this file as usual.**

## What was happening

`/[collection]/player/[slug]` degraded its "top sales" section **14 times in 24 h**, most
recently **2026-08-31T17:37:01Z**, with
`[entity-section] player top sales get_player_top_sales failed after retries: canceling
statement due to statement timeout — degraded`.

`get_player_top_sales` carries `SET statement_timeout = '8s'`. Reproduced on
`nba_top_shot / lebron-james`: **cold 8,178 ms / 34,952 buffers — over its own cap.**

## Why

To return 10 rows it read **34,154 sales rows across 126 editions** and top-N heapsorted them.
All seven `sales` partitions already carry
`sales_<year>_edition_id_price_usd_idx (edition_id, price_usd DESC)` — ~253 MB of exactly the
right index. **A btree `DESC` column orders NULLS FIRST**, so
`ORDER BY price_usd DESC NULLS LAST` could not be satisfied from it and the planner ignored
the lot.

Two traps worth carrying forward:

1. ⚠ **The indexes are invisible to `pg_indexes WHERE tablename='sales'`** — they are
   per-partition, not attached to the ONLY-parent. Query the partitions
   (`indexname LIKE 'sales_20%edition_id%'`) before concluding an index is missing.
2. ⚠ **It was not a statistics problem, and the rule caught that.** Cold and warm touched the
   *same* buffers with a 29× wall-clock spread (8,178 ms vs 277 ms). `last_analyze` on every
   partition was 08-31 04:52Z (2026 at 10:53Z). Pure IO residency — the 08-31 04:55Z
   vacuum/analyze fix does not apply.

## The fix, and the falsifier that changed it

Shipped as `20260831183251`: a per-edition
`JOIN LATERAL (… ORDER BY s.price_usd DESC, s.sold_at DESC LIMIT v_safe_limit)` and the same
outer sort. Plan is now a **Merge Append of seven ordered Index Scans + Incremental Sort with
`Presorted Key: price_usd`**.

⭐ **The obvious version was wrong and the equivalence test proved it.** Ordering the LATERAL
by `price_usd DESC` alone gave **1 mismatch in 25 players** — Ben Gordon, 3 sale ids each
way — because an edition whose sales **tie at the cut price** truncated arbitrarily before
the outer `sold_at DESC` could choose. The tiebreak has to live **inside** the LATERAL. It
costs nothing: 5,208 → 5,462 buffers on the bare SQL. Re-run over **79 players in two
disjoint slices (25 + 54): 0 mismatches.**

`NULLS LAST` is provably vacuous: `sales.price_usd` is `is_nullable = NO` and **0 of
4,853,856 rows** are NULL.

## Result, through the function

| | buffers | wall |
|---|---|---|
| before, cold | 34,952 | **8,178 ms (timed out)** |
| before, warm | 34,912 | 277 ms |
| **after, cold** | 11,563 | **860 ms** |
| **after, warm** | **10,104** | **36.7 ms** |

Post-flight: anon/authenticated EXECUTE still **false**, service_role **true**;
`check_secdef_anon_execute_violations()` → `[]`; 10 rows returned, top sale $230,023;
**Pinnacle branch untouched and smoke-tested.**

## Exit condition

Vercel runtime-error group *"player top sales get_player_top_sales failed after retries"* on
`/[collection]/player/[slug]`, over a 24 h window that does **not** straddle the migration —
**from 2026-09-01 18:30Z onward**: **PASS at 0 occurrences · FALSIFIED at ≥ 8** (baseline 14).
FALSIFIED ⇒ revert the body; do **not** raise the 8 s timeout.

## Next, probably the same shape

`get_edition_recent_sales` on `/[collection]/edition/[slug]` — same 8 s in-function cap,
**9 occurrences** in 24 h, alongside 19 of `[edition] market_bundle canceling statement due
to statement timeout`. Already `plpgsql` + SECDEF, so **not** the known-issues #13 param-blind
`LANGUAGE sql` class. Check its plan for the same unused-ordered-index shape before assuming.
