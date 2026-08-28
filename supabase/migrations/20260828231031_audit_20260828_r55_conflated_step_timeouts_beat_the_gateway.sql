-- audit_20260828_r55_conflated_step_timeouts_beat_the_gateway
-- R55 (deep-audit run 4): drain-conflated-subeditions has failed 4 consecutive daily
-- ticks since 08-24 with 'upstream request timeout'. Mechanism (proven from extra.step_ms):
-- four step RPCs run into the ~120s Supabase GATEWAY cap before their own DB
-- statement_timeout can fire, so the route's designed 57014-truncation contract
-- ('truncated_steps', non-fatal, retried next tick) never engages — the gateway error
-- is deliberately NOT reclassified by the route, and it reds the whole run.
--   split/realign declared 300s: UNREACHABLE via PostgREST (gateway kills at ~120s;
--     the server may keep burning up to 300s after the client is gone);
--   seed_miskeyed/detector_only declared 120s: a coin-flip race the gateway has been
--     winning since 08-24 (step_ms 120,3xx on every tick).
-- Fix: declare 110s on all four, safely under the gateway, so the DB cancel fires
-- first and the truncation contract works as designed. Path facts (2026-08-27 A/B):
-- the attached SET BINDS on the PostgREST path (this route) and is INERT on pg_cron
-- (jobid 62 calls detector_only; cron_heavy's 600s budget governs there, unchanged).
-- The three pinned functions are re-created VERBATIM from their pin files with ONLY
-- the timeout token changed (bodies byte-identical, same signatures => ACLs preserved);
-- pins + drift-guard migration pointers updated in the same commit.
-- Revert: re-apply the previous values — split/realign SET statement_timeout='300s',
-- detector_only='120s', seed_topshot_miskeyed_subedition_targets='120s' (ALTER FUNCTION ... SET).

-- verbatim from supabase/tests/remap_topshot_split_resolved_subeditions.sql with ONLY the statement_timeout value changed
CREATE OR REPLACE FUNCTION public.remap_topshot_split_resolved_subeditions(p_limit integer DEFAULT 8000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sales int := 0; v_wmc int := 0; v_moments int := 0; v_skipped int := 0;
BEGIN
  DROP TABLE IF EXISTS _split;
  CREATE TEMP TABLE _split ON COMMIT DROP AS
  SELECT sub.nft_id, sub.base_external_id AS base, se.external_id AS sub_ext,
         be.id AS base_ed_id, se.id AS sub_ed_id
  FROM topshot_moment_subeditions sub
  JOIN editions be ON be.collection_id = v_ts AND be.external_id = sub.base_external_id
  JOIN editions se ON se.collection_id = v_ts AND se.external_id = sub.base_external_id || '::' || sub.subedition_id
  WHERE sub.subedition_id > 0 AND sub.base_external_id ~ '^[0-9]+:[0-9]+$'
    -- Bind the LIMIT to rows with real work: still base-keyed somewhere.
    -- Without this the LIMIT samples an arbitrary slice of a 673k-row table that
    -- is ~99% already-split, and the drain is structurally blind to the backlog.
    AND (
      EXISTS (SELECT 1 FROM wallet_moments_cache w
               WHERE w.moment_id::text = sub.nft_id AND w.collection_id = v_ts
                 AND w.edition_key = sub.base_external_id)
      OR EXISTS (SELECT 1 FROM moments m
                  WHERE m.nft_id = sub.nft_id AND m.collection_id = v_ts
                    AND m.edition_id = be.id)
      OR EXISTS (SELECT 1 FROM sales s
                  WHERE s.nft_id = sub.nft_id AND s.collection_id = v_ts
                    AND s.edition_id = be.id)
    )
  LIMIT greatest(1, p_limit);

  -- Conflation knots: a base moment whose target ::N already holds that serial
  -- under a DIFFERENT nft. Skip these across all three tables (left on base).
  DROP TABLE IF EXISTS _split_collide;
  CREATE TEMP TABLE _split_collide ON COMMIT DROP AS
  SELECT DISTINCT x.nft_id
  FROM _split x
  JOIN moments m  ON m.nft_id = x.nft_id AND m.collection_id = v_ts AND m.edition_id = x.base_ed_id
  JOIN moments m2 ON m2.edition_id = x.sub_ed_id AND m2.serial_number = m.serial_number AND m2.nft_id <> m.nft_id;
  GET DIAGNOSTICS v_skipped = ROW_COUNT;

  -- SALES
  INSERT INTO audit_20260704_subedition_split_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'sales', s.nft_id, x.base, x.sub_ext, s.id::text
  FROM sales s JOIN _split x ON x.nft_id = s.nft_id
  WHERE s.collection_id = v_ts AND s.edition_id = x.base_ed_id
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = s.nft_id);
  UPDATE sales s SET edition_id = x.sub_ed_id
  FROM _split x WHERE s.nft_id = x.nft_id AND s.collection_id = v_ts AND s.edition_id = x.base_ed_id
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = s.nft_id);
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  -- WMC
  INSERT INTO audit_20260704_subedition_split_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'wmc', w.moment_id::text, x.base, x.sub_ext, w.wallet_address
  FROM wallet_moments_cache w JOIN _split x ON x.nft_id = w.moment_id::text
  WHERE w.collection_id = v_ts AND w.edition_key = x.base
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = w.moment_id::text);
  UPDATE wallet_moments_cache w SET edition_key = x.sub_ext
  FROM _split x WHERE w.moment_id::text = x.nft_id AND w.collection_id = v_ts AND w.edition_key = x.base
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = w.moment_id::text);
  GET DIAGNOSTICS v_wmc = ROW_COUNT;

  -- MOMENTS
  UPDATE moments m SET edition_id = x.sub_ed_id, updated_at = now()
  FROM _split x WHERE m.nft_id = x.nft_id AND m.collection_id = v_ts AND m.edition_id = x.base_ed_id
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = m.nft_id);
  GET DIAGNOSTICS v_moments = ROW_COUNT;

  RETURN jsonb_build_object('sales_split', v_sales, 'wmc_split', v_wmc,
                            'moments_split', v_moments, 'collisions_skipped', v_skipped);
END
$function$;

-- verbatim from supabase/tests/remap_topshot_realign_miskeyed_subeditions.sql with ONLY the statement_timeout value changed
CREATE OR REPLACE FUNCTION public.remap_topshot_realign_miskeyed_subeditions(p_limit integer DEFAULT 8000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '110s'
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

-- verbatim from supabase/tests/refresh_topshot_conflated_editions_detector_only.sql with ONLY the statement_timeout value changed
CREATE OR REPLACE FUNCTION public.refresh_topshot_conflated_editions_detector_only()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '110s'
AS $function$
DECLARE n integer;
BEGIN
  DROP TABLE IF EXISTS _confd;
  CREATE TEMP TABLE _confd ON COMMIT DROP AS
    SELECT ms.edition_id, count(*)::int AS shared_serials
    FROM (
      SELECT edition_id, serial_number
      FROM sales
      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
        AND serial_number > 0 AND nft_id IS NOT NULL
        AND sold_at > now() - interval '365 days'
      GROUP BY edition_id, serial_number HAVING count(DISTINCT nft_id) > 1
    ) ms
    GROUP BY ms.edition_id;
  DELETE FROM public.topshot_conflated_editions WHERE true;
  INSERT INTO public.topshot_conflated_editions (edition_id, shared_serials, detected_at)
    SELECT edition_id, shared_serials, now() FROM _confd;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;

-- seed_topshot_miskeyed_subedition_targets is NOT drift-guard-pinned; a plain ALTER suffices.
ALTER FUNCTION public.seed_topshot_miskeyed_subedition_targets(integer) SET statement_timeout = '110s';
