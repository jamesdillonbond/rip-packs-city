-- anon-exec: none (no function touched; one watchlist row re-calibrated)
--
-- APPLIED 2026-11-10 ~7:45 AM PT (Claude Code cloud, apply_migration; recorded version 20261110154319).
-- Staged 4:40 AM PT by the Cowork audit pass, whose apply_migration was refused. Re-derived before
-- apply: board 22 rows, flat at 22 since the 11-09 7:35 PM PT owner-moved sweep (95 -> 22 in one step).
--
-- WHY. candy_offer_spread_board's liveness floor (min_rows = 30) was calibrated 2026-08-01
-- as 25% of a 122-row population. The Candy book has contracted with the wind-down.
-- MEASURED 2026-11-10 4:35 AM PT: 20 active asks, 7 active offers, 18 editions with a
-- confirmed floor, board = 22 rows (282 ms, no error). The 11-09 7:35 PM PT sweep retired
-- 208 of 228 asks as owner-moved. 30 now sits above the whole population, so
-- public_board_empty_count reads 1 on a board that is serving every row it can.
--
-- Same rule, current population: 25% of 22 = 5 (collapse, not churn). Kept ACTIVE on
-- purpose: a board that still has rows should page if it falls to ~0. Deactivate with a
-- stated reason (candy_deals_board precedent, 2026-08-01) only if the Candy book empties.
--
-- PRE-CHECK (expect min_rows = 30, is_active = true):
--   select min_rows, is_active from public.public_board_liveness_watchlist
--    where view_name = 'candy_offer_spread_board';
-- POST-CHECK: min_rows = 5; after the next liveness sweep `public_board_empty_count` = 0.
--
-- REVERT: update public.public_board_liveness_watchlist set min_rows = 30
--         where view_name = 'candy_offer_spread_board';
update public.public_board_liveness_watchlist
set min_rows = 5,
    note = 'RECALIBRATED 2026-11-10 PT: min_rows 30 -> 5. The 2026-08-01 floor was 25% of a 122-row population; after the Candy wind-down the whole board is 22 rows (20 active asks, 7 active offers, 18 editions with a confirmed floor, measured 4:35 AM PT), so 30 sat above the population and read as an empty-board breach on a healthy board. Same rule on the current population: 25% of 22 = 5 (collapse, not churn). Stays ACTIVE; deactivate with a stated reason (candy_deals_board precedent) only if the Candy book empties. max_ms unchanged (3000). Previous note: ' || coalesce(note, '')
where view_name = 'candy_offer_spread_board'
  and min_rows = 30;
