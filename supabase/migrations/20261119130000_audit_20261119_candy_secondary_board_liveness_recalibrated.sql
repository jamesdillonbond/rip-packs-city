-- audit_20261119_candy_secondary_board_liveness_recalibrated
--
-- 2026-11-19 (PT, ~12:45 PM by DB clock; Claude Code cloud; Trevor: sentinel WARN "Trust Health:
-- public_board_slow_count=1 (breach at 1)").
-- The one slow board was candy_secondary_board: 3,096 ms at 3:28 AM PT and 3,884 ms on 11-18 against
-- max_ms 3000. Its calibration (2026-08-01) was 125 rows / 2 ms, so the rule produced the 3000 ms FLOOR. Since
-- 20261108191456 the Candy edition views carry EVERY Candy set: the board is now 21,472-24,665 rows (170x).
-- The liveness probe evaluates every row (count(t.*)), i.e. the all-Candy-sales per-edition aggregate for all
-- 21k editions -- 3.4 s measured today, 2.76 s of it disk reads. No reader does that: the page reads the 2026
-- Base set (set_id filter, limit 600) in 67 ms. Not user-facing; a calibration that no longer fits the board.
--
-- WHAT. Re-apply the arm's own current rule to the current population (the 11-10 candy_offer_spread_board
-- precedent): max_ms = 6x the warm p50, 3000 floor, 25000 cap -> 7-day history (27 probes) p50 2145 ms -> 13000.
-- min_rows = 25% of the population (collapse, not churn): 31 (of 125) -> 5368 (of 21,472), so a collapse of the
-- 21k board can no longer pass as healthy. The max seen in 7 days (15,642 ms) would still breach -- correctly.
--
-- REVERT: UPDATE public.public_board_liveness_watchlist SET max_ms = 3000, min_rows = 31,
--   note = <the previous note, kept below after "Previous note:"> WHERE view_name = 'candy_secondary_board';

UPDATE public.public_board_liveness_watchlist
   SET max_ms = 13000,
       min_rows = 5368,
       note = 'RECALIBRATED 2026-11-19 PT: max_ms 3000 -> 13000, min_rows 31 -> 5368. Since 2026-11-08 the board carries every Candy set (21,472-24,665 rows, was 125); the probe evaluates every row (3.4 s today, mostly disk reads of the all-sales aggregate) while the page reads the Base set in 67 ms. Same rules on the current population: 6x the 7-day warm p50 (2145 ms over 27 probes) and 25% of 21,472. Previous note: ' || coalesce(note, '')
 WHERE view_name = 'candy_secondary_board' AND max_ms = 3000 AND min_rows = 31;
