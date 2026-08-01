# Code TODOs

Out-of-scope follow-ups flagged during the AllDay unmapped-resolver build (2026-05-05). Address in separate commits.

## 1. compute-topshot-pack-ev seeds NULL UUID:UUID skeleton edition rows — RESOLVED (2026-05-24)

Resolved in `compute-topshot-pack-ev` v19 (commit `4b1fc82`) by folding inline hydration directly into the edge function. After `seed_topshot_editions` and the EV insert, the function loops the just-seeded UUID:UUID external_ids through Top Shot's `searchEditions` GQL (one call per row, time-budgeted against `HARD_CEILING_MS`) and updates the editions row directly. New counters `editions_hydrated` / `editions_hydration_failed` / `editions_hydration_skipped_budget` are surfaced in `pipeline_runs.extra`.

Backlog drained from 992 → 24 (97.6%) via:

- Patched `scripts/rehydrate-null-topshot-editions.mjs` (commit `8f0de84`) — the script was deriving `set_id_onchain` only when `external_id` matched `^\d+:\d+$`, ignoring the integer `row.set.flowId` / `row.play.flowID` that the GQL response carries for UUID lookups. Two passes resolved ~1042 rows.
- One-shot SQL JOIN from `sets.set_id_onchain` for the 444 UUID:UUID phantoms whose `play.flowID` Top Shot's public API doesn't expose (no current listings via `searchMomentListings.byEditions` either) — keeps the resolver-compatible state for the parent set even when the play integer stays unknown.

Residual 24 rows are pre-existing legacy noise (bare-UUID and bare-integer external_ids), not part of this leak. Hydrator `edition_resolution_failures` is now 0 in the 24h after deploy.

## 2. TopShot + AllDay Deposit-event ownership scanner — SUPERSEDED / consumer-gated (re-assessed 2026-07-31)

> **Deep-dive verdict (2026-07-31): do NOT build this as written — see [docs/handoff-2026-07-31-ownership-scanner-todo-deepdive.md](handoff-2026-07-31-ownership-scanner-todo-deepdive.md).** The "multi-session architecture project" framing below predates the solution that actually shipped.

DB-side primitives are in place (all verified live 2026-07-31, all SECURITY DEFINER): `scanner_get_progress`, `scanner_advance_progress`, `upsert_topshot_ownership_batch`, `upsert_allday_ownership_batch`. **But the scaffold is inert and abandoned:** the four `topshot/allday-deposit-scan-*` cursors in `flow_backfill_progress` are frozen at height 150585016 with 0 events since 2026-05-05, `topshot_ownership_snapshots` holds 1 test row, and `allday_ownership_snapshots` is empty. Nothing reads either table.

**What happened instead:**

- **TopShot ownership is already solved** by a different, live, healthy two-pipeline design (landed 2026-06-26): Dune event-replay (`sync-topshot-ownership-dune`) + a per-wallet FCL verification walk (`ownership-onchain-walk`) → `topshot_ownership` (**267,742 rows, fresh daily**, sources `dune,onchain_walk`), consumed by `lib/set-completers-board.ts`. The Deposit-scanner for TopShot is **redundant — retire it, don't finish it.**
- **AllDay ownership is a genuine gap** (no index exists) **but has no product consumer**, so building it now is premature per the "keep parallel until a real consumer exists" rule. When/if greenlit, generalize the two live TopShot pipelines to AllDay (Option A in the handoff) — a ~1-day job using the proven `pinnacle-owner-discovery-forward` template, not a multi-session build.

Full contracts, event types, spork floor, cursor-reset notes, and optional retirement SQL are in the handoff.
