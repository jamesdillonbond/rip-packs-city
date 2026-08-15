-- Snapshot migration: public.remap_topshot_from_onchain_map().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-15) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical), so
-- it is committed UNAPPLIED — every apply_migration costs a ~10-20s burst of
-- user-facing PGRST002 500s and this one would buy nothing.
--
-- Re-keys `sales` AND `moments` onto the edition the on-chain map says the moment
-- belongs to. The two halves are deliberately asymmetric and that asymmetry is
-- the whole design:
--
--   • SALES are re-keyed unconditionally (no uniqueness to protect).
--   • MOMENTS are re-keyed FREE-SLOT ONLY. _mv_free excludes any row whose target
--     (edition_id, serial_number) is already held by a DIFFERENT moment. Those
--     are not forced and not silently dropped — they are counted out as
--     `moments_deferred_conflict` in the return value.
--
-- The `o.id <> mv.moment_pk` clause in that NOT EXISTS is what stops a row being
-- treated as its own conflict; without it every candidate blocks itself and the
-- moments half silently becomes a no-op that still reports success.
--
-- Both audit tables are written with the SAME predicate as their UPDATE, so they
-- are faithful revert paths.
--
-- Pinned by supabase/tests/remap_topshot_from_onchain_map.sql.

CREATE OR REPLACE FUNCTION public.remap_topshot_from_onchain_map()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sales int := 0;
  v_moments int := 0;
  v_mv_total int := 0;
  v_unresolved int := 0;
BEGIN
  -- Authoritative target edition per mapped nft: prefer ::subID parallel edition, else base.
  DROP TABLE IF EXISTS _tgt;
  CREATE TEMP TABLE _tgt ON COMMIT DROP AS
  SELECT m.nft_id,
         m.serial_number AS new_serial,
         COALESCE(epar.id, ebase.id) AS new_edition_id
  FROM topshot_misattrib_onchain_map m
  LEFT JOIN topshot_moment_subeditions sub
         ON sub.nft_id = m.nft_id AND COALESCE(sub.subedition_id,0) > 0
  LEFT JOIN editions ebase
         ON ebase.collection_id = v_ts
        AND ebase.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text)
  LEFT JOIN editions epar
         ON sub.subedition_id IS NOT NULL AND epar.collection_id = v_ts
        AND epar.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text || '::' || sub.subedition_id::text);

  SELECT count(*) INTO v_unresolved FROM _tgt WHERE new_edition_id IS NULL;

  -- ── SALES re-key (primary) ──
  INSERT INTO audit_topshot_sale_drain_remap_20260621 (sale_id,nft_id,old_edition_id,old_serial,new_edition_id,new_serial)
  SELECT s.id, s.nft_id, s.edition_id, s.serial_number, t.new_edition_id, t.new_serial
  FROM sales s JOIN _tgt t ON t.nft_id = s.nft_id
  WHERE s.collection_id = v_ts AND t.new_edition_id IS NOT NULL
    AND (s.edition_id <> t.new_edition_id OR s.serial_number IS DISTINCT FROM t.new_serial);

  UPDATE sales s
  SET edition_id = t.new_edition_id,
      serial_number = COALESCE(t.new_serial, s.serial_number)
  FROM _tgt t
  WHERE s.nft_id = t.nft_id AND s.collection_id = v_ts AND t.new_edition_id IS NOT NULL
    AND (s.edition_id <> t.new_edition_id OR s.serial_number IS DISTINCT FROM t.new_serial);
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  -- ── MOMENTS re-key (safe, free-slot only) ──
  DROP TABLE IF EXISTS _mv;
  CREATE TEMP TABLE _mv ON COMMIT DROP AS
  SELECT m.id AS moment_pk, m.nft_id, m.edition_id AS old_ed, m.serial_number AS old_ser,
         t.new_edition_id AS new_ed, COALESCE(t.new_serial, m.serial_number) AS new_ser
  FROM moments m JOIN _tgt t ON t.nft_id = m.nft_id
  WHERE m.collection_id = v_ts AND t.new_edition_id IS NOT NULL
    AND (m.edition_id <> t.new_edition_id OR m.serial_number IS DISTINCT FROM COALESCE(t.new_serial, m.serial_number));
  SELECT count(*) INTO v_mv_total FROM _mv;

  DROP TABLE IF EXISTS _mv_free;
  CREATE TEMP TABLE _mv_free ON COMMIT DROP AS
  SELECT mv.* FROM _mv mv
  WHERE NOT EXISTS (
    SELECT 1 FROM moments o
    WHERE o.collection_id = v_ts AND o.edition_id = mv.new_ed AND o.serial_number = mv.new_ser AND o.id <> mv.moment_pk
  );

  INSERT INTO audit_topshot_moment_drain_remap_20260621 (moment_pk,nft_id,old_edition_id,old_serial,new_edition_id,new_serial,action)
  SELECT moment_pk,nft_id,old_ed,old_ser,new_ed,new_ser,'update' FROM _mv_free;

  UPDATE moments m
  SET edition_id = f.new_ed, serial_number = f.new_ser, updated_at = now()
  FROM _mv_free f WHERE m.id = f.moment_pk;
  GET DIAGNOSTICS v_moments = ROW_COUNT;

  RETURN jsonb_build_object(
    'sales_rekeyed', v_sales,
    'moments_rekeyed', v_moments,
    'moments_deferred_conflict', v_mv_total - v_moments,
    'unresolved_targets', v_unresolved,
    'map_size', (SELECT count(*) FROM topshot_misattrib_onchain_map)
  );
END $function$;
