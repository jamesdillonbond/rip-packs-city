-- topshot_pack_reality_top_ev is a MARKET-DRIVEN +EV board that can honestly hold
-- zero rows. Carry it is_active=false with a stated reason, matching the
-- candy_deals_board / topshot_underpriced_serials_board precedent (both 2026-08-01),
-- so an honest empty stops registering as a permanent public_board_empty_count BREACH
-- that would mask the next genuinely-dark board.
--
-- MEASURED 2026-08-30 (15:5x PT), which REFUTES the filing's stated fix:
--   * The live writer is ALIVE: pg_cron jobid 217 (rpc-atlas-pack-ev, :25), last run
--     22:25Z. Today it wrote 56 Top Shot rows with price_source and total_unopened
--     populated, avg fmv_coverage_pct 100.0, pack_ev from -892.87 to -1.65 --
--     ZERO positive-EV. The board is empty because nothing is +EV, not because of
--     a NULL-handling default.
--   * The 10 "revived positive-EV rows" are from jobid 71 (:13,
--     backfill_topshot_historical_pack_ev) -- HISTORICAL reconstructions carrying
--     NULL price_source, NULL total_unopened AND NULL depletion_pct. They are not
--     live inventory and must not be published as buyable.
--   => Landing the depletion leg would NOT repopulate this board. Both of the
--      filing's premises ("a writer has revived", "one NULL default suppresses
--      100% of it") are wrong; the depletion NULL is a symptom, not the cause.
--
-- NOT a blind silencing: topshot_pack_reality_dist (6 rows) and
-- topshot_pack_reality_stats (1 row) remain is_active=true and healthy, so a real
-- pack-reality pipeline break still pages through them.
--
-- REVERT: update public_board_liveness_watchlist set is_active=true where
--         view_name='topshot_pack_reality_top_ev';
update public.public_board_liveness_watchlist
set note = 'DEACTIVATED 2026-08-30 PT: a TOP +EV pack board can legitimately hold zero rows -- an honest market state, not an outage, same class as candy_deals_board and topshot_underpriced_serials_board (both deactivated 2026-08-01). min_rows=1 meant ANY empty state paged. MEASURED at deactivation: the live writer (pg_cron jobid 217 rpc-atlas-pack-ev, :25) is HEALTHY -- 56 Top Shot packs today, price_source and total_unopened populated, avg fmv_coverage_pct 100.0, pack_ev range -892.87 to -1.65, zero positive. The only positive-EV rows in pack_ev_latest come from jobid 71 (:13, backfill_topshot_historical_pack_ev), which are HISTORICAL reconstructions with NULL price_source/total_unopened/depletion_pct -- correctly excluded by the view''s COALESCE(depletion_pct,100) < 90 guard, and NOT safe to publish as buyable. Landing the depletion leg would therefore NOT repopulate this board. Sibling arms topshot_pack_reality_dist and topshot_pack_reality_stats stay ACTIVE, so a genuine pack-reality break still pages. RE-ACTIVATE once a live Top Shot ask source is restored (the Atlas migration, inbox 2026-08-30T1610Z) AND the atlas writer is observed producing positive-EV rows with non-null depletion -- at that point a zero really would mean the board broke.',
    is_active = false
where view_name = 'topshot_pack_reality_top_ev';
