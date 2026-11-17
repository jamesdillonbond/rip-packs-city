# The parallel-circulation self-heal is a STRUCTURAL NO-OP, its audit table is a fabricated repair log, and its DB-invariant pin cannot see either — 2026-09-11T09:27Z

Filed by Claude Code on Trevor's box (interactive, 02:27 PT). Found by asking why a live trust-board
breach was not clearing, **not** by an alert. Every reading below is from the live instance.

---

## What is breached

`topshot_impossible_parallel_serials` = **4** against `breach_at` **3** → `v_rpc_trust_health` is
**37/38**. The arm counts Top Shot sales on `::`-parallel editions whose `serial_number` exceeds the
edition's `circulation_count` — an impossible, scarcity-distorting state. Precomputed 09-11 06:48Z
(46,773 ms). ⛔ **This is NOT a regression from the 09:14Z `board_mv_refresh_max_stale_hours` ship** —
it was already breached 2.5 h before that migration.

## The self-heal runs perfectly and does nothing

`rpc-selfheal-impossible-parallel-circ` (pg_cron, `43 0,6,12,18 * * *`, active) calls
`raise_impossible_parallel_circ()`, which raises an offending parallel's `circulation_count` to its
max sold serial. **Every run for months reads `succeeded`, `"1 row"`.** The audit table
`impossible_parallel_circ_raises` holds **274 rows across 188 editions**.

🚨 **It cannot work, and this is proven rather than argued.** A `BEFORE` trigger function,
`trg_topshot_normalize_base_club_circulation`, fires on every `editions` write and for a Top Shot
**parallel** does:

```
ELSE
  -- Parallel: Atlas is the only per-printing authority, in both directions.
  NEW.circulation_count := v_atlas;
```

an **unconditional overwrite** from `badge_editions` (Atlas). Live test, rolled back via `RAISE` so
nothing persisted:

```
before=99 | wrote=140 | after_trigger=99 | badge_editions_atlas=99
```

**The UPDATE is reverted inside the same statement.** The function is a no-op for every parallel that
has an Atlas authority row — **185 of the 188** it has ever claimed to raise.

⭐ **And the trigger is RIGHT.** 99 is the true circulation of a WNBA `Club Collection` parallel; 500
is right for `Explosion`. The self-heal is the wrong actor: it inflates a CORRECT circulation to
accommodate sales that should never have been keyed to that edition.

## The audit table is a fabricated repair log

- **168 of 188** claimed raises are **not reflected in the current data** (current `circulation_count`
  ≠ the `new_circ` the audit claims). The log overstates by ~9×.
- **3 editions are in a hard 6-hourly loop** — same `old_circ` every single run:
  - `270:8973::17` (Paige Bueckers, *WNBA Hoop Vision*, `Blockchain` parallel): **`old_circ = 99`
    eleven times**, 09-09 00:43 → 09-11 06:43, every slot.
  - `90:4055::1` (Shai Gilgeous-Alexander, `Explosion`): **`old_circ = 500` seven times**, 09-09 18:43
    → 09-11 06:43.
- ⭐ **The shape:** the function computes a raise, the trigger reverts it, the audit row is written
  anyway from the pre-trigger CTE value, and `jsonb_build_object('raised', …)` counts UPDATEs
  *attempted*, not rows *changed*. **A reader of either the log or the return value concludes the
  self-heal is working.**

## The DB-invariant pin passes because its fixture omits the blocker

`supabase/tests/raise_impossible_parallel_circ.sql` asserts `raised = '1'` and `circ raised to 25`.
It passes — and it is **structurally incapable of failing on this defect**, because it
`CREATE TABLE`s its own `editions` / `sales` / `impossible_parallel_circ_raises` inside a rolled-back
transaction. That fixture has **no `badge_editions` table and no trigger**, so it validates the
function in a world where the thing that breaks it does not exist.

⭐⭐ **THE TRANSFERABLE RULE: the pin guards the function's BLAST RADIUS and is silent about its
EFFICACY.** Its own header says *"A regression here would silently mutate circulation on the wrong
editions"* — every assertion is about what it must NOT touch (non-parallels, other collections,
within-circ editions). **Not one asserts that a raise SURVIVES.** Both are legitimate concerns; only
one is covered, and the docs read as though the function is verified working. **A verbatim-copy pin
inherits the fixture's world, not production's.**

## The correct fix already exists and has no caller

`remap_topshot_parallel_to_base_misattributed()` re-keys mis-attributed sales from the parallel
edition back to the BASE edition — the right direction, and carefully guarded (it requires either a
confirmed `subedition_id = 0` for the moment, or no matching subedition record **and**
`serial > parallel.circulation_count` **and** `base.circulation_count >= serial`).

⛔ **`cron.job` holds NO job calling it.** Neither for its `remap_topshot_wmc_parallel_to_base_misattributed`
sibling. The estate runs the healer that cannot work four times a day and never runs the one that can.

## Suggested actions — NOT taken here, and why

1. **Make the instrument honest (low risk, no data mutation).** `RETURNING e.circulation_count` *does*
   see the BEFORE-trigger rewrite — verified live, rolled back. So the function can audit only raises
   that actually persisted and return `attempted` / `raised` / `reverted_by_trigger`. It would then
   report `raised: 0` every run and the problem becomes visible instead of hidden. ⚠ **Cost:** it is a
   **pinned** function — changing it means the migration, the byte-identical copy in
   `supabase/tests/`, and `__tests__/db-invariants-drift-guard.test.ts` all move together, and the
   fixture must gain a `badge_editions` + trigger case or the pin stays vacuous.
2. **Retire `rpc-selfheal-impossible-parallel-circ`** — it is a proven no-op for 185/188. ⚠ Not done
   autonomously: it removes a (weak) safety net for the 3 editions with no Atlas authority, where its
   writes *can* persist, and that is a judgement about which direction to fail.
3. 🚨 **Schedule / run `remap_topshot_parallel_to_base_misattributed()` — TREVOR'S CALL, NOT
   AUTONOMOUS.** It mutates `sales.edition_id`, which is an FMV input. It is the only one of the three
   that would actually clear the breach.

**Risk of doing nothing:** the breach persists, `circulation_count` stays correct (the trigger is
holding the line), but Top Shot parallel editions keep carrying sales that belong to their base
edition — which distorts per-edition sale history and anything derived from it.
