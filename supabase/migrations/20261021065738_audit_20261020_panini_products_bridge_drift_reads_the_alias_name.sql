-- audit_20261020_panini_products_bridge_drift_reads_the_alias_name
--
-- 2026-10-20 11:57 PM PT (Claude Code cloud; Trevor: "work on roadmap items and known issues").
--
-- WHAT WAS WRONG. sync_panini_products_bridge (pg_cron :24/:54) rewrote the same 14 editions on every
-- tick (`editions_written: 14`, 10:24 and 10:54 PM PT 10-20). All 14 are Megan DiLeo's cards: the source
-- card says "Megan Gustafson", the editions trigger a_normalize_player_name_alias_* stores the alias's
-- canonical "Megan DiLeo" (merge 20261004190200), and the bridge's drift test compared the stored name
-- with the RAW source name — so the pair never matched and the upsert ran forever (~670 rewrites a day,
-- each bumping updated_at on an unchanged row).
--
-- WHAT CHANGES. The drift test compares the stored name with the name the trigger would store: the
-- alias's players.name when the card resolved through player_name_aliases (src.alias_player), else the
-- source name. A CASE, so the lookup runs only for aliased cards. Nothing else moves; md5-guarded splice.
--
-- Measured in rolled-back blocks before apply: the new body wrote 2 rows (two other editions with real
-- drift) and an immediate second run wrote 0. The old body writes the same 14 every tick (production).
--
-- anon-exec: unchanged (sync_panini_products_bridge) — CREATE OR REPLACE of the same signature keeps its ACL.
--
-- REVERT: re-run the splice in reverse (new fragment -> old fragment); pre-change body md5 pinned below.
DO $mig$
DECLARE
  d text;
  n int;
  c_md5 constant text := '26676ab41f685ac2d9ef156db9d77e39';
  o constant text := E'           IS DISTINCT FROM (src.tier, src.mint_cap, src.player_name, src.set_name, src.set_id)\n';
  nw constant text := E'           IS DISTINCT FROM (src.tier, src.mint_cap,\n'
    || E'                             CASE WHEN src.alias_player IS NULL THEN src.player_name\n'
    || E'                                  ELSE coalesce((SELECT ap.name FROM public.players ap WHERE ap.id = src.alias_player), src.player_name) END,\n'
    || E'                             src.set_name, src.set_id)\n';
BEGIN
  SELECT md5(prosrc) INTO d FROM pg_proc WHERE oid = 'public.sync_panini_products_bridge(interval)'::regprocedure;
  IF d <> c_md5 THEN RAISE EXCEPTION 'sync_panini_products_bridge body moved (md5 %), re-read before splicing', d; END IF;
  d := pg_get_functiondef('public.sync_panini_products_bridge(interval)'::regprocedure);
  n := (length(d) - length(replace(d, o, ''))) / length(o);
  IF n <> 1 THEN RAISE EXCEPTION 'drift anchor found % times, want 1', n; END IF;
  d := replace(d, o, nw);
  EXECUTE d;
END
$mig$;
