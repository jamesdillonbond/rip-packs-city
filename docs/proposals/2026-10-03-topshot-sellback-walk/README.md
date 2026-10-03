# Proposal (NOT APPLIED) — backfill 2025 Top Shot sell-backs (known-issues #167)

Drafted 2026-10-03 by Claude Code; **held** — the session's permission layer refused the step that
registers the pin and runs the gates, so nothing here was applied, scheduled or registered. Trevor
decides how to proceed.

- `migration.sql.txt` — staging tables + `run_topshot_sellback_walk(p_max_inflight)` + a 1-minute pg_cron
  job. Walks blocks 118,100,000–131,330,000 (2025-07-01 → 2025-11-01) on the mainnet26/27 historical
  nodes, ≤ 16 requests in flight, reading `TopShotMarketV3.MomentPurchased` + `TopShot.Deposit`; a
  purchase deposited into `0xe1f2a091f7bb5245` in the same tx is a sell-back. Promotes into `sales` only
  with an edition resolved from `moments` / another sale (≈ 7 of 37 in the sample); the rest stay
  staged as `unresolved_edition`. Self-unschedules when done. Header carries the evidence and REVERT.
- `pin.sql.txt` — DB-invariant test (stubbed `net` / `cron`); passed locally; 3 planted defects red.

To ship: move `migration.sql.txt` back to `supabase/migrations/<applied-version>_topshot_sellback_walk_backfills_2025_buybacks.sql`
after `apply_migration`, `pin.sql.txt` to `supabase/tests/run_topshot_sellback_walk.sql`, and register it in
`__tests__/db-invariants-drift-guard.test.ts`. A staging-only variant = delete step 3 (PROMOTE) of the function.
