# Code TODOs

Out-of-scope follow-ups flagged during the AllDay unmapped-resolver build (2026-05-05). Address in separate commits.

## 1. compute-topshot-pack-ev seeds NULL UUID:UUID skeleton edition rows — RESOLVED (2026-05-24)

Resolved in `compute-topshot-pack-ev` v19 (commit `4b1fc82`) by folding inline hydration directly into the edge function. After `seed_topshot_editions` and the EV insert, the function loops the just-seeded UUID:UUID external_ids through Top Shot's `searchEditions` GQL (one call per row, time-budgeted against `HARD_CEILING_MS`) and updates the editions row directly. New counters `editions_hydrated` / `editions_hydration_failed` / `editions_hydration_skipped_budget` are surfaced in `pipeline_runs.extra`.

Backlog drained from 992 → 24 (97.6%) via:

- Patched `scripts/rehydrate-null-topshot-editions.mjs` (commit `8f0de84`) — the script was deriving `set_id_onchain` only when `external_id` matched `^\d+:\d+$`, ignoring the integer `row.set.flowId` / `row.play.flowID` that the GQL response carries for UUID lookups. Two passes resolved ~1042 rows.
- One-shot SQL JOIN from `sets.set_id_onchain` for the 444 UUID:UUID phantoms whose `play.flowID` Top Shot's public API doesn't expose (no current listings via `searchMomentListings.byEditions` either) — keeps the resolver-compatible state for the parent set even when the play integer stays unknown.

Residual 24 rows are pre-existing legacy noise (bare-UUID and bare-integer external_ids), not part of this leak. Hydrator `edition_resolution_failures` is now 0 in the 24h after deploy.

## 2. TopShot + AllDay Deposit-event ownership scanner — DB scaffold only

DB-side primitives are in place via these RPCs (added during recent sessions):

- `scanner_get_progress`
- `scanner_advance_progress`
- `upsert_topshot_ownership_batch`
- `upsert_allday_ownership_batch`

The actual scanner edge function — the one that polls the Flow port-8070 spork API, parses Deposit events, and feeds them into the upsert RPCs — has not been built. It's a separate multi-session architecture project (event window cursors, spork rollovers, two-collection routing, retry/dead-letter handling), not a single-edge-function patch.

When picked up, mirror the cooldown / retry / runtime-budget shape of `sales-serial-backfill` and the cursor-resume shape of `compute-allday-pack-ev`.
