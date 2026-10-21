-- audit_20261020_rank_thresholds_comment_names_both_classes
--
-- Comment-only. get_topshot_player_rank_thresholds (20261020222800) reads
-- topshot_rookie_collector_leaderboard_mv, which covers the 2025 AND 2026 rookie classes since
-- 20261020225100; its COMMENT still said "2025-rookie". No body, signature or ACL change.
--
-- REVERT: re-run the COMMENT ON FUNCTION in 20261020222800.

COMMENT ON FUNCTION public.get_topshot_player_rank_thresholds(text) IS
  'What the 1st/3rd/10th/26th collector on a Top Shot rookie board (2025 and 2026 classes) holds (RPC-FMV value, Moment count) and how many collectors the board has, from topshot_rookie_collector_leaderboard_mv (Top Shot system accounts excluded). A proxy for Top Shot''s locked-TSS boards: it counts every walk-confirmed holding at FMV, locked or not. NULL row = fewer collectors than that rank. audit_20261020.';
