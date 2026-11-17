-- Snapshot migration: public.remap_topshot_realign_miskeyed_subeditions(integer).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-15) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical), so
-- it is committed UNAPPLIED — every apply_migration costs a ~10-20s burst of
-- user-facing PGRST002 500s and this one would buy nothing.
--
-- Realigns rows sitting on the WRONG parallel of the right base: `48:1652::7`
-- when the moment belongs on `48:1652::5`, or on a parallel when it belongs on
-- the base. Distinct from remap_topshot_split_resolved_subeditions, which moves
-- rows OFF the base onto a parallel — this one fixes rows already carrying a
-- `::N` suffix.
--
-- The confining predicate is `cur.external_id LIKE x.base || '::%'`: every write
-- requires the row to currently sit on a `::`-suffixed edition OF THE SAME BASE.
-- That is what keeps a realign from dragging a row across bases; drop it and the
-- sweep would re-key rows it was never meant to touch.
--
-- Collisions (target parallel already holds that serial under a different nft)
-- are skipped across all three tables, and — unlike its sibling — all three
-- writes are audited into audit_20260705_subedition_realign_remap.
--
-- Pinned by supabase/tests/remap_topshot_realign_miskeyed_subeditions.sql.

CREATE OR REPLACE FUNCTION public.remap_topshot_realign_miskeyed_subeditions(p_limit integer DEFAULT 8000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_moments int := 0; v_sales int := 0; v_wmc int := 0; v_skipped int := 0;
BEGIN
  DROP TABLE IF EXISTS _sub_ed;
  CREATE TEMP TABLE _sub_ed ON COMMIT DROP AS
  SELECT id, external_id, split_part(external_id,'::',1) AS base
  FROM editions WHERE collection_id = v_ts AND external_id ~ '::';

  DROP TABLE IF EXISTS _realign;
  CREATE TEMP TABLE _realign ON COMMIT DROP AS
  SELECT DISTINCT cur.nft_id, cur.base,
         (CASE WHEN sub.subedition_id = 0 THEN sub.base_external_id
               ELSE sub.base_external_id || '::' || sub.subedition_id END) AS correct_ext,
         tgt.id AS correct_ed_id
  FROM (
    SELECT m.nft_id, se.base, se.external_id AS cur_ext
    FROM moments m JOIN _sub_ed se ON se.id = m.edition_id WHERE m.collection_id = v_ts
    UNION
    SELECT s.nft_id, se.base, se.external_id
    FROM sales s JOIN _sub_ed se ON se.id = s.edition_id WHERE s.collection_id = v_ts
    UNION
    SELECT w.moment_id AS nft_id, split_part(w.edition_key,'::',1) AS base, w.edition_key AS cur_ext
    FROM wallet_moments_cache w WHERE w.collection_id = v_ts AND w.edition_key ~ '::'
  ) cur
  JOIN topshot_moment_subeditions sub
    ON sub.nft_id = cur.nft_id AND sub.subedition_id IS NOT NULL AND sub.base_external_id = cur.base
  JOIN editions tgt
    ON tgt.collection_id = v_ts
   AND tgt.external_id = (CASE WHEN sub.subedition_id = 0 THEN sub.base_external_id
                               ELSE sub.base_external_id || '::' || sub.subedition_id END)
  WHERE cur.cur_ext <> (CASE WHEN sub.subedition_id = 0 THEN sub.base_external_id
                             ELSE sub.base_external_id || '::' || sub.subedition_id END)
  LIMIT greatest(1, p_limit);

  -- Collision set: mis-keyed moments whose correct edition already holds that
  -- serial under a DIFFERENT nft. These are left in place (flagged, not moved).
  DROP TABLE IF EXISTS _collide;
  CREATE TEMP TABLE _collide ON COMMIT DROP AS
  SELECT DISTINCT x.nft_id
  FROM _realign x
  JOIN moments m ON m.nft_id = x.nft_id AND m.collection_id = v_ts
  JOIN moments m2 ON m2.edition_id = x.correct_ed_id AND m2.serial_number = m.serial_number AND m2.nft_id <> m.nft_id;
  GET DIAGNOSTICS v_skipped = ROW_COUNT;

  -- MOMENTS (clean only)
  INSERT INTO audit_20260705_subedition_realign_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'moments', m.nft_id, cur.external_id, x.correct_ext, m.nft_id
  FROM moments m
  JOIN _realign x ON x.nft_id = m.nft_id
  JOIN editions cur ON cur.id = m.edition_id
  WHERE m.collection_id = v_ts AND cur.external_id LIKE x.base || '::%' AND m.edition_id <> x.correct_ed_id
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = m.nft_id);
  UPDATE moments m SET edition_id = x.correct_ed_id, updated_at = now()
  FROM _realign x, editions cur
  WHERE m.nft_id = x.nft_id AND m.collection_id = v_ts
    AND cur.id = m.edition_id AND cur.external_id LIKE x.base || '::%'
    AND m.edition_id <> x.correct_ed_id
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = m.nft_id);
  GET DIAGNOSTICS v_moments = ROW_COUNT;

  -- SALES (clean only — mirror the same nft exclusion for consistency)
  INSERT INTO audit_20260705_subedition_realign_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'sales', s.nft_id, cur.external_id, x.correct_ext, s.id::text
  FROM sales s
  JOIN _realign x ON x.nft_id = s.nft_id
  JOIN editions cur ON cur.id = s.edition_id
  WHERE s.collection_id = v_ts AND cur.external_id LIKE x.base || '::%' AND s.edition_id <> x.correct_ed_id
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = s.nft_id);
  UPDATE sales s SET edition_id = x.correct_ed_id
  FROM _realign x, editions cur
  WHERE s.nft_id = x.nft_id AND s.collection_id = v_ts
    AND cur.id = s.edition_id AND cur.external_id LIKE x.base || '::%'
    AND s.edition_id <> x.correct_ed_id
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = s.nft_id);
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  -- WMC (clean only)
  INSERT INTO audit_20260705_subedition_realign_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'wmc', w.moment_id, w.edition_key, x.correct_ext, w.wallet_address
  FROM wallet_moments_cache w
  JOIN _realign x ON x.nft_id = w.moment_id
  WHERE w.collection_id = v_ts AND w.edition_key LIKE x.base || '::%' AND w.edition_key <> x.correct_ext
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = w.moment_id);
  UPDATE wallet_moments_cache w SET edition_key = x.correct_ext
  FROM _realign x
  WHERE w.moment_id = x.nft_id AND w.collection_id = v_ts
    AND w.edition_key LIKE x.base || '::%' AND w.edition_key <> x.correct_ext
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = w.moment_id);
  GET DIAGNOSTICS v_wmc = ROW_COUNT;

  RETURN jsonb_build_object('moments_realigned', v_moments, 'sales_realigned', v_sales,
                            'wmc_realigned', v_wmc, 'collisions_skipped', v_skipped);
END
$function$;
