-- audit_20260922_pack_sales_history_suppress_redundant_updates
--
-- known-issues #35's open half: the WRITE AMPLIFICATION. backfill-allday-pack-sales and
-- backfill-topshot-pack-sales re-walk immutable historical sales and PostgREST upserts every
-- row with `ON CONFLICT (tx_hash, pack_nft_id) DO UPDATE SET <every column> = EXCLUDED.<column>`
-- and no change-detection predicate, so each re-walk rewrites identical rows.
-- Measured 2026-09-22 PT (pg_stat_user_tables, lifetime): allday 381 inserts vs 17,230,083
-- updates; topshot 11,021 vs 25,589,132. Pre-ship rate 12:31 -> 12:34 PM PT: allday +3,000,
-- topshot +4,400 updates in 3.1 min, 0 inserts (~1.4 M + ~2.0 M rewrites/day). Visibility maps
-- 1.5 % / 7.7 % all-visible: every page is re-dirtied between autovacuum passes, which is why
-- tuning the autovacuum trigger (0.02 on 09-19, backed off to 0.1 the same night) could not keep
-- the map clean. The churn is the defect, not the vacuum cadence.
--
-- Fix: suppress_redundant_updates_trigger() (built into Postgres) as a BEFORE UPDATE row trigger.
-- A row whose new image is byte-identical to the old one is skipped: no new tuple, no dead
-- tuple, no dirtied page, no WAL. A real change (e.g. nft_status moving) still updates normally.
--
-- WHY THE #35 BLOCKER NO LONGER APPLIES: #35 held this back because a suppressed row emits no
-- RETURNING and "a caller asserting on that count would break silently", with both writers
-- having no committed source. Both deployed builds are verified verbatim in
-- docs/audits/edge-fleet-staging-2026-08-28/<fn>/index.ts.txt (ezbr_sha256 80a3f0a7... and
-- c1976d0a..., matched against list_edge_functions 2026-09-22) and neither reads RETURNING:
-- `.upsert(rows, {onConflict})` with no `.select()` is return=minimal, and `written` is
-- `rows.length`. No DB function writes these tables. No other trigger exists on them.
--
-- EXIT (24 h): n_tup_upd on each table rises < 10 % of its pre-ship rate while n_tup_ins keeps
--   pace with new sales; relallvisible/relpages climbs past 80 % after the next autovacuum;
--   both lanes keep advancing their cursors.
-- FALSIFIER: n_tup_ins stalls => something relied on the update; revert.
-- REVERT: DROP TRIGGER trg_suppress_redundant_updates ON public.allday_pack_sales_history;
--         DROP TRIGGER trg_suppress_redundant_updates ON public.topshot_pack_sales_history;
-- Applied from Cowork cloud 2026-09-22.

CREATE TRIGGER trg_suppress_redundant_updates
  BEFORE UPDATE ON public.allday_pack_sales_history
  FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();

CREATE TRIGGER trg_suppress_redundant_updates
  BEFORE UPDATE ON public.topshot_pack_sales_history
  FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'trg_suppress_redundant_updates'
         AND c.relnamespace = 'public'::regnamespace
         AND c.relname IN ('allday_pack_sales_history','topshot_pack_sales_history')) <> 2 THEN
    RAISE EXCEPTION 'suppress trigger not on both tables';
  END IF;
END $$;
