-- audit_20260802_recalibrate_materialized_board_liveness_budgets
-- Applied to prod 2026-08-02 03:33 UTC / 2026-08-01 20:33 PT via Supabase MCP.
-- This file is the idempotent repo record.
--
-- Recalibrates the public_board_slow_count budgets for the two boards
-- materialized earlier in the same session. Both were pinned at the 25,000 ms
-- CAP because 6x their warm time exceeded the ~30s read wall (44,283 ms and
-- 25,062 ms) -- the watchlist note itself documented this as "capped so it
-- warns before it breaks".
--
-- They now read from an MV: 1.5 ms and 0.14 ms warm. Leaving max_ms at 25,000
-- would make the slow arm DEAD WEIGHT for exactly the two boards it was
-- introduced to watch -- a regression back to 10s would not fire.
--
-- New budget follows the table's own stated convention: 6x warm, floor 3000 ms,
-- cap 25000 ms. 6x warm is <10 ms for both, so the 3000 ms floor applies.
--
-- REVERT:
--   UPDATE public.public_board_liveness_watchlist SET max_ms = 25000
--    WHERE view_name IN ('topshot_perfect_mint_premiums_board','topshot_pack_reality_dist');

UPDATE public.public_board_liveness_watchlist
   SET max_ms = 3000,
       note = note || ' RECALIBRATED 2026-08-02 PT: board materialized behind an hourly MV '
            || '(see audit_20260802_*_materialize); warm went 14761ms/8354ms -> ~1ms, so the '
            || '25000ms CAP was retired for the 6x-warm/3000ms-floor rule. NOTE: an MV means a '
            || 'DEAD REFRESH now shows up as STALE data, which neither this arm nor '
            || 'public_board_empty_count can see -- a failing pg_cron refresh is caught by '
            || 'check_pgcron_recent_failures(), an UNSCHEDULED one is not.'
 WHERE view_name IN ('topshot_perfect_mint_premiums_board','topshot_pack_reality_dist')
   AND max_ms <> 3000;
