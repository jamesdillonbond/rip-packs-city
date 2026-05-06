# Code TODOs

Out-of-scope follow-ups flagged during the AllDay unmapped-resolver build (2026-05-05). Address in separate commits.

## 1. compute-topshot-pack-ev seeds NULL UUID:UUID skeleton edition rows

`compute-topshot-pack-ev` creates 4–66 NULL UUID:UUID skeleton rows in `editions` per run via its `editions_seeded` path. Hydrating those skeletons currently requires a manual run of `scripts/rehydrate-null-topshot-editions.mjs`.

Pick one:

- Schedule the rehydrate script via cron-job.org every ~4 hours so the skeletons don't accumulate.
- Or, fold the hydrate path inline into `compute-topshot-pack-ev` so a freshly seeded skeleton gets fully populated in the same invocation that created it.

Tracked here so this doesn't get lost behind the unmapped-resolver work.

## 2. TopShot + AllDay Deposit-event ownership scanner — DB scaffold only

DB-side primitives are in place via these RPCs (added during recent sessions):

- `scanner_get_progress`
- `scanner_advance_progress`
- `upsert_topshot_ownership_batch`
- `upsert_allday_ownership_batch`

The actual scanner edge function — the one that polls the Flow port-8070 spork API, parses Deposit events, and feeds them into the upsert RPCs — has not been built. It's a separate multi-session architecture project (event window cursors, spork rollovers, two-collection routing, retry/dead-letter handling), not a single-edge-function patch.

When picked up, mirror the cooldown / retry / runtime-budget shape of `sales-serial-backfill` and the cursor-resume shape of `compute-allday-pack-ev`.
