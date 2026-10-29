-- audit_20261029_allday_degraded_notice_says_trading_restarted_thin — 2026-10-29 10:32 AM PT applied (Claude Code cloud).
--
-- The NFL All Day degraded notice (collection_config.metadata.marketplace.notes, rendered on the deals
-- board and the collection pages) said "trading has not restarted yet ... can't be bought until it
-- does". On 10-29 that was false: sales_market recorded All Day trades every hour since 11 PM PT 10-28
-- (58 sales; 28 in the 7 AM PT hour), from 1-4 buyers an hour. Volume is still under the restore bar
-- (8 sales and 5 buyers per 2 h), so the notice correctly stays up. Only its wording is wrong.
--
-- WHAT CHANGES: only metadata.marketplace.notes for nfl_all_day. status stays 'degraded',
-- marketplace_saved is untouched, and restore_dapper_maintenance_notice() still swaps the saved block
-- back on volume (or at the 11-04 backstop), which drops this text with it.
-- Guarded on the exact current text so a restore or another session's edit is never overwritten.
-- REVERT: set notes back to the previous text (quoted in the guard below).

DO $mig$
DECLARE
  v_old CONSTANT text := 'Dapper''s NFL All Day site is back up after maintenance (down since about 9:30 AM PT on Oct 27), but trading has not restarted yet. Listings, asks and deals here may be out of date and can''t be bought until it does; this notice clears itself when trading is back. FMV and portfolio tools still work.';
  v_new CONSTANT text := 'Dapper''s NFL All Day site is back up after maintenance (down since about 9:30 AM PT on Oct 27). Trading has restarted, but volume is still far below normal, so listings, asks and deals here may be out of date. This notice clears itself when trading volume recovers. FMV and portfolio tools still work.';
  v_n integer;
BEGIN
  UPDATE public.collection_config cc
     SET metadata = jsonb_set(cc.metadata, '{marketplace,notes}', to_jsonb(v_new))
    FROM public.collections c
   WHERE c.id = cc.collection_id
     AND c.slug = 'nfl_all_day'
     AND cc.metadata ? 'marketplace_saved'
     AND cc.metadata #>> '{marketplace,notes}' = v_old;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected to reword exactly 1 notice, matched %', v_n;
  END IF;
END
$mig$;
