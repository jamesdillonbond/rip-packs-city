# Two DB pins went stale on **2026-09-04** and `db-pin-staleness` has been red every run since — the repo is COMPLETE, the pins just were not repointed

*Claude Code, Trevor's box · MEASUREMENT + a refuted hypothesis, nothing changed · 2026-09-05 03:40 PT*

## What is red

`db-pin-staleness.yml` (daily) failed its most recent run and **succeeded the two before it**, so the drift appeared in that window. Its output names two functions:

```
STALE   detect_stalled_pipelines
  pinned migration: 20260903024204_audit_20260902_detect_stalled_pipelines_says_whether_the_schedule_is_firing.sql
STALE   upsert_wmc_batch
  pinned migration: 20260812033600_audit_20260812_snapshot_upsert_wmc_batch.sql
  → the live definition differs from the pinned copy.
```

## ⛔ The alarming hypothesis is REFUTED — production does NOT carry DDL the repo lacks

My first reading was the serious one: `grep 'CREATE OR REPLACE FUNCTION public.detect_stalled_pipelines'` across `supabase/migrations/` returns the **pinned** migration as the newest match, which looks exactly like the recorded *"MCP `apply_migration` bypasses the repo"* shape — live DDL with no repo file.

**It is not that.** `20260904041635_audit_20260904_watchlist_cron_silent_grace_for_new_rows_and_window_ge_threshold.sql` **does** change the function — it reads `pg_get_functiondef()` into a variable and rewrites it programmatically, so there is no literal `CREATE OR REPLACE FUNCTION public.detect_stalled_pipelines` line for a grep to find. The live body carries that migration's own marker:

```sql
-- 2026-09-04: a row younger than its own threshold cannot be stalled yet (grace for new pipelines)
AND w.created_at < now() - (w.max_silent_minutes * interval '1 minute')
```

⚠ **Worth keeping as a grep lesson:** a migration that edits a function *programmatically* is invisible to the obvious `CREATE OR REPLACE FUNCTION <name>` search. Searching for the FUNCTION NAME alone (`grep -rln 'detect_stalled_pipelines'`) found it immediately; searching for the DDL spelling did not.

## So it is the simple thing, for both

| function | pinned at | actually changed by |
|---|---|---|
| `detect_stalled_pipelines` | `20260903024204` (09-03) | **`20260904041635`** — programmatic edit, adds the `created_at` grace |
| `upsert_wmc_batch` | `20260812033600` (08-12) | **`20260904062632`** — a literal `CREATE OR REPLACE`, "keys a resolved parallel at write time" |

Both are 09-04 migrations that changed a pinned function without repointing `PINS` in `__tests__/db-invariants-drift-guard.test.ts`. **The repo is complete; the pins are behind.**

## ⛔ Why this was NOT fixed here, and it is not squeamishness

The guard's own message says the quiet part: *"repoint the PINS entry, **and re-check the test's ASSERTIONS** — a stale pin usually means the assertions describe old behaviour."* That is the whole job, and it is not mechanical:

- `upsert_wmc_batch` now **keys a resolved parallel at write time**, a real semantic change to the write path behind `wmc`. Whether `supabase/tests/upsert_wmc_batch.sql`'s assertions still describe it is a question for whoever made that change.
- `detect_stalled_pipelines` gained a grace window, which changes **which rows it returns** — exactly the kind of thing an existing assertion can keep passing on while no longer testing the current behaviour.

⚠ Memory also records that **repointing a pin needs a COLUMN-level fixture audit**, because `supabase/tests/*.sql` run against real fixtures. A blind repoint would turn a red instrument green while leaving the assertions describing 08-12 behaviour — strictly worse than the current red, which at least tells the truth.

## Cheap next step for whoever owns those two migrations

1. Capture each live definition with `pg_get_functiondef()` into a snapshot migration.
2. Repoint the two `PINS` entries at the new snapshots.
3. **Re-read `supabase/tests/detect_stalled_pipelines.sql` and `supabase/tests/upsert_wmc_batch.sql` and ask whether each assertion still describes what the function now does** — particularly the parallel-keying change.

ⓘ Scope note: this is the DAILY drift check, not a production defect. Nothing user-facing is broken by it. The cost is the same one the three dead Top Shot pipelines carry (inbox `2026-09-05T1015Z`) — **a red instrument nobody can read at a glance**, and this one has been red since 09-04.
