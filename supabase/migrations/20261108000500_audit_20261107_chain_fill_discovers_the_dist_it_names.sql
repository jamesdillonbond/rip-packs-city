-- audit_20261107_chain_fill_discovers_the_dist_it_names — 2026-11-07 (Cowork cloud, ~4:10 PM PT).
--
-- `fill_pack_dist_from_chain_mints` (`:47`) stamped 1,908 purchases with dist 8920 at 1:47 and
-- 3:47 PM PT, but `pack_distributions` had NO 8920 row until the 3-hourly dist-names cron
-- (`/api/cron/topshot-pack-dist-names-onchain`, `25 */3`) next ran `discover_missing_topshot_pack_distributions`
-- — its 2:25 PM run saw `discovered 0` because the stamp landed AFTER it. So a brand-new drop
-- read "NBA Top Shot Pack #8920" (no title, no tier, no image) on every surface for up to three
-- hours after the chain had named it. Two writers, one fact, ordered by clock: the filler now
-- ALSO creates the placeholder row for every dist it names that the table lacks — the same
-- shape `discover_missing_topshot_pack_distributions` writes (`nft_type`, `metadata.seeded_from`),
-- title NULL — so the naming pass fills it on its next tick whatever the order. Fill-only:
-- `ON CONFLICT DO NOTHING`, never a title. Reported as `dists_discovered` in extra; the
-- rows_written count stays rips + purchases (what the function has always meant by it).
--
-- Base verified before this CREATE OR REPLACE: live prosrc md5 e27300305e7b06b8fdb478b172b24925 ==
-- the body in 20261102232403 (same normalisation).
--
-- anon-exec: unchanged (fill_pack_dist_from_chain_mints) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
--
-- REVERT: re-apply the body from 20261102232403_audit_20261102_pack_dist_from_chain_mints.sql.

CREATE OR REPLACE FUNCTION public.fill_pack_dist_from_chain_mints(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_lim int := greatest(1, least(coalesce(p_limit, 5000), 20000));
  v_rips int := 0;
  v_purch int := 0;
  v_dists int := 0;
BEGIN
  WITH t AS (
    SELECT r.id, r.pack_nft_id, r.dist_id AS old_dist_id, m.dist_id AS new_dist_id
    FROM public.pack_rips r
    JOIN public.pack_nft_mints m ON m.collection_id = r.collection_id AND m.pack_nft_id = r.pack_nft_id
    WHERE r.collection_id = v_ts
      AND r.dist_id IS NULL                       -- idx_pack_rips_unattributed
      AND m.dist_id IS NOT NULL AND m.dist_id ~ '^[0-9]+$'
    LIMIT v_lim
  ), logged AS (
    INSERT INTO public.pack_dist_chain_fill_log (kind, row_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT 'rip', id, pack_nft_id, old_dist_id, new_dist_id FROM t
    RETURNING row_id, new_dist_id
  ), upd AS (
    UPDATE public.pack_rips r SET dist_id = l.new_dist_id
    FROM logged l WHERE r.id = l.row_id
    RETURNING 1
  )
  SELECT count(*) INTO v_rips FROM upd;

  WITH t AS (
    SELECT p.id, p.pack_nft_id, p.pack_dist_id AS old_dist_id, m.dist_id AS new_dist_id
    FROM public.pack_purchases p
    JOIN public.pack_nft_mints m ON m.collection_id = p.collection_id AND m.pack_nft_id = p.pack_nft_id
    WHERE p.collection_id = v_ts
      AND p.pack_dist_id IS NULL                  -- idx_pack_purchases_dist_unresolved
      AND m.dist_id IS NOT NULL AND m.dist_id ~ '^[0-9]+$'
    LIMIT v_lim
  ), logged AS (
    INSERT INTO public.pack_dist_chain_fill_log (kind, row_id, pack_nft_id, old_dist_id, new_dist_id)
    SELECT 'purchase', id, pack_nft_id, old_dist_id, new_dist_id FROM t
    RETURNING row_id, new_dist_id
  ), upd AS (
    UPDATE public.pack_purchases p SET pack_dist_id = l.new_dist_id
    FROM logged l WHERE p.id = l.row_id
    RETURNING 1
  )
  SELECT count(*) INTO v_purch FROM upd;

  -- 2026-11-07: a dist named from the chain gets its placeholder row at once, so the
  -- dist-names cron can title it on its next pass whatever the clock order; title stays NULL
  -- (the name is PDS's to write), and an existing row is never touched. The window is the
  -- last day of fills, not just this run, so a dist stamped before this shipped (8920) is
  -- caught too; the log holds only rows filled since 11-02 and the NOT EXISTS makes a
  -- re-scan free.
  WITH named AS (
    SELECT DISTINCT new_dist_id AS dist_id
    FROM public.pack_dist_chain_fill_log
    WHERE filled_at > now() - interval '1 day'
      AND new_dist_id ~ '^[0-9]+$'
  ), ins AS (
    INSERT INTO public.pack_distributions (collection_id, dist_id, nft_type, metadata)
    SELECT v_ts, n.dist_id, 'A.0b2a3299cc857e29.PackNFT.NFT',
           jsonb_build_object('seeded_from', 'discovered_from_chain_mints')
    FROM named n
    WHERE NOT EXISTS (SELECT 1 FROM public.pack_distributions pd
                       WHERE pd.collection_id = v_ts AND pd.dist_id = n.dist_id)
    ON CONFLICT (dist_id, collection_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_dists FROM ins;

  -- rows_written = rows actually updated (each logged with its old value first).
  PERFORM public.log_pipeline_run('pack-dist-from-chain-mints', v_started, v_rips + v_purch, v_rips + v_purch, 0, true, NULL,
                                  'nba_top_shot', NULL, NULL,
                                  jsonb_build_object('rips_filled', v_rips, 'purchases_filled', v_purch, 'dists_discovered', v_dists));
  RETURN jsonb_build_object('ok', true, 'rips_filled', v_rips, 'purchases_filled', v_purch, 'dists_discovered', v_dists);
END
$function$;
