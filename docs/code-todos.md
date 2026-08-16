# Code TODOs

Out-of-scope follow-ups flagged during the AllDay unmapped-resolver build (2026-05-05). Address in separate commits.

## 1. compute-topshot-pack-ev seeds NULL UUID:UUID skeleton edition rows — RESOLVED (2026-05-24)

Resolved in `compute-topshot-pack-ev` v19 (commit `4b1fc82`) by folding inline hydration directly into the edge function. After `seed_topshot_editions` and the EV insert, the function loops the just-seeded UUID:UUID external_ids through Top Shot's `searchEditions` GQL (one call per row, time-budgeted against `HARD_CEILING_MS`) and updates the editions row directly. New counters `editions_hydrated` / `editions_hydration_failed` / `editions_hydration_skipped_budget` are surfaced in `pipeline_runs.extra`.

Backlog drained from 992 → 24 (97.6%) via:

- Patched `scripts/rehydrate-null-topshot-editions.mjs` (commit `8f0de84`) — the script was deriving `set_id_onchain` only when `external_id` matched `^\d+:\d+$`, ignoring the integer `row.set.flowId` / `row.play.flowID` that the GQL response carries for UUID lookups. Two passes resolved ~1042 rows.
- One-shot SQL JOIN from `sets.set_id_onchain` for the 444 UUID:UUID phantoms whose `play.flowID` Top Shot's public API doesn't expose (no current listings via `searchMomentListings.byEditions` either) — keeps the resolver-compatible state for the parent set even when the play integer stays unknown.

Residual 24 rows are pre-existing legacy noise (bare-UUID and bare-integer external_ids), not part of this leak. Hydrator `edition_resolution_failures` is now 0 in the 24h after deploy.

## 2. TopShot + AllDay Deposit-event ownership scanner — RESOLVED by RETIREMENT (2026-08-05), closed out 2026-08-16

> **Deep-dive verdict (2026-07-31): do NOT build this as written — see [docs/handoff-2026-07-31-ownership-scanner-todo-deepdive.md](handoff-2026-07-31-ownership-scanner-todo-deepdive.md).** The "multi-session architecture project" framing below predates the solution that actually shipped.

**The scaffold no longer exists.** The handoff's §6 retirement SQL — which that document still describes as "NOT run — gated on a cleanup decision" — was applied on 2026-08-05 as `supabase/migrations/20260805015722_audit_20260805_retire_deposit_scanner_ownership_scaffold.sql` (present in `supabase_migrations.schema_migrations`, so migration parity is clean). Re-verified live 2026-08-16:

| object | 2026-07-31 | live 2026-08-16 |
|---|---|---|
| `topshot_ownership_snapshots` | 1 test row | **dropped** |
| `allday_ownership_snapshots` | 0 rows | **dropped** |
| `upsert_topshot_ownership_batch(jsonb)` | exists | **dropped** |
| `upsert_allday_ownership_batch(jsonb)` | exists | **dropped** |
| `resolve_special_serials_from_ownership(text,int)` | dormant | **dropped** |
| 4 × `topshot/allday-deposit-scan-*` cursors | frozen @ 150585016 | **deleted** (`flow_backfill_progress` holds 5 rows, the 2 live Pinnacle cursors among them) |

⚠ **Do not read the paragraphs below as current state** — they are the 2026-07-31 assessment, kept because they are why the retirement was the right call. **The two generic RPCs `scanner_get_progress` / `scanner_advance_progress` were deliberately KEPT** (the handoff's own carve-out: generic over `flow_backfill_progress`, reusable by a future scanner). Re-checked 2026-08-16 — both still dormant (0 function-body callers, 0 `cron.job` callers, 0 in-repo references) but correctly locked down (`has_function_privilege` false for both `anon` and `authenticated`), so they cost nothing and are not a drift item. Leave them.

The LIVE special-serial path the handoff warned not to touch is intact: `special_serial_holders` = 25 rows, its refresh cron still scheduled, and `topshot_ownership` = 267,742 rows.

**Revert path:** `git revert` the migration commit is not sufficient (the file only contains DROPs) — recreate from git history of the 2026-05-05 scaffold migration plus the `resolve_special_serials_from_ownership` migration, then re-seed the 4 cursor rows. Nothing depends on any of it, so a revert is unlikely to ever be wanted.

---

*Historical (2026-07-31 assessment, superseded by the retirement above):*

DB-side primitives are in place (all verified live 2026-07-31, all SECURITY DEFINER): `scanner_get_progress`, `scanner_advance_progress`, `upsert_topshot_ownership_batch`, `upsert_allday_ownership_batch`. **But the scaffold is inert and abandoned:** the four `topshot/allday-deposit-scan-*` cursors in `flow_backfill_progress` are frozen at height 150585016 with 0 events since 2026-05-05, `topshot_ownership_snapshots` holds 1 test row, and `allday_ownership_snapshots` is empty. Nothing reads either table.

**What happened instead:**

- **TopShot ownership is already solved** by a different, live, healthy two-pipeline design (landed 2026-06-26): Dune event-replay (`sync-topshot-ownership-dune`) + a per-wallet FCL verification walk (`ownership-onchain-walk`) → `topshot_ownership` (**267,742 rows, fresh daily**, sources `dune,onchain_walk`), consumed by `lib/set-completers-board.ts`. The Deposit-scanner for TopShot is **redundant — retire it, don't finish it.**
- **AllDay ownership is a genuine gap** (no index exists) **but has no product consumer**, so building it now is premature per the "keep parallel until a real consumer exists" rule. When/if greenlit, generalize the two live TopShot pipelines to AllDay (Option A in the handoff) — a ~1-day job using the proven `pinnacle-owner-discovery-forward` template, not a multi-session build.

Full contracts, event types, spork floor, and cursor-reset notes are in the handoff. Its §6 retirement SQL is no longer optional or pending — it ran (see the table at the top of this section); the cursor-reset notes are now moot because those cursor rows are deleted.

⚠ **Unrelated live finding surfaced while verifying the above (2026-08-16), NOT part of this TODO:** `ownership-onchain-walk` — the on-chain confirmation half of the surviving TopShot design named below — has **failed two consecutive daily ticks** (08-15 and 08-16 13:30Z), both `threw: stale-wallets: Timed out acquiring connection from connection pool`, so it wrote 0 rows and `topshot_ownership`'s freshest `observed_at` is stuck at 2026-08-14. Saturation-class, so it belongs to the platform-wide root cause rather than a separate investigation — but it is **on no `pipeline_cadence_watchlist` entry**, and the cadence detector is structurally blind to it because the cron fires perfectly and it is the work inside that dies. Filed: [inbox 2026-08-16T1734Z](overnight/inbox/2026-08-16T1734Z-ownership-onchain-walk-has-failed-two-daily-ticks-unwatched.md).
