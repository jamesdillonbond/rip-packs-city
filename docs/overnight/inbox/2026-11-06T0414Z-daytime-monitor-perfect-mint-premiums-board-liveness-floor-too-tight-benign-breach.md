# public_board_empty_count BREACH — `topshot_perfect_mint_premiums_board` floor too tight for a market-driven premium board (benign; no dark surface)

**When:** surfaced 2026-11-06 ~04:05Z (rpc-daytime-monitor, cloud pass). Precompute `checked_at` 2026-11-06 00:28Z.
**Priority:** LOW (tuning). Not a user-visible outage — the board renders real rows.
**Source:** `rpc_ops_snapshot().trust_health_breaches = ["public_board_empty_count"]`; `public_board_liveness_state` row `view_name='topshot_perfect_mint_premiums_board'`.

## What tripped
`public_board_empty_count` = 1 (breach_at 1) — the dark-public-board arm. The single tripped board is
`topshot_perfect_mint_premiums_board`: **row_count 42 vs min_rows 44**, `elapsed_ms 12`, `err NULL`.

## Why this is NOT the class the arm exists to catch
The arm was built for the candy_holder_board silent-lie class: a SLOW view whose fail-soft catches a timeout and
returns `[]` → a blank public board indistinguishable from an honest empty result. This is the opposite:
- The query is **healthy and fast** (12 ms, no error) and returns **42 real rows** — the public
  `/insights/serial-premiums` "Perfect mint" toggle renders a populated board, not a blank empty-state.
- The count has **declined gradually over a week** — history: 56 (11-02/03) → 54 → 53 (11-04) → 45 → 44 (11-05 20:28Z)
  → 42 (11-06 00:28Z). This is market-driven premium compression (fewer editions whose latest perfect-mint sale in
  90 d is ≥ 5× the 180-day median at ≥ 15 sales), not an ingestion break. Supporting: `topshot_fmv_stale_hours` 0.3,
  `board_mv_refresh_stale_hours` 1.96 (breach 8), no stalled pipelines, sentinel editions-48h 0 — TS sales/FMV all fresh.

## Root cause of the false BREACH
`min_rows = 44` is "25% of measured population", but this board's **recent live population band is ~42–56**, so the floor
sits inside the normal fluctuation band. Any honest downward tick now trips a breach_at-1 arm that cannot distinguish
premium-compression churn from a real collapse — exactly the two-genuinely-can-be-empty-market-board problem the arm
already handles for `candy_deals_board` and `topshot_underpriced_serials_board` (carried `is_active=false` WITH a reason).

## Suggested action (night pass — sense-only here, no change made)
Pick one, both are one-row writes to `public_board_liveness_watchlist`, no migration:
1. **Re-baseline** `min_rows` to ~25% of the board's CURRENT measured population (recent ~50 → floor ~12–13), restoring
   the collapse-not-churn semantics the arm intends; **or**
2. **Carry `is_active=false` WITH a stated reason** like the two existing premium/market boards, if perfect-mint premium
   count is considered an honest market condition that should not page.
Option 1 keeps a live watch (preferred). Confirm first that 42 is genuine market state (it is, per the gradual
week-long slope + fresh TS sales), not a sudden drop.

## Risk read
Low. Read-only observation; the public board is live and correct. The only defect is a miscalibrated liveness floor
producing a benign trust BREACH that will keep tripping on normal churn until re-baselined (cf. the 2026-08-02
`audit_20260802_recalibrate_materialized_board_liveness_budgets` precedent for this same board's max_ms arm).
