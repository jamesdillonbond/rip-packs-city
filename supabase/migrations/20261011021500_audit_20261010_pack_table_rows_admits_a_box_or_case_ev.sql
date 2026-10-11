-- audit_20261010_pack_table_rows_admits_a_box_or_case_ev
-- definer-view: intentional — pack_table_rows was already a definer view (reloptions NULL) and is listed in
--   security_definer_view_allowlist; CREATE OR REPLACE keeps that unchanged (read back 10-10).
--
-- 2026-10-10 (known-issues #188 item 1, follow-up to 20261011020800). The pack table joins an EV row
-- only when the dist has a pull pool (EXISTS pack_drop_pool) -- a pack with no pool has nothing to value.
-- A box or case has no pool BY CONSTRUCTION (it yields packs, not moments); refresh_container_pack_ev
-- values it as the sum of its inner packs, and 22 such rows reached mv_pack_ev_latest on the first run,
-- but the gate dropped every one (pack_table_rows read gross_ev NULL for all of them). The gate now also
-- admits a dist that is a container in pack_container_recipes. Every other gate (sentinel, 3x-ask,
-- coverage >= 25, price < 9999) still applies to it. No other row can change: the new arm matches
-- only container dists, and none of them has a pool.
-- Applied as an anchored rewrite of the LIVE definition (the anchor must match exactly once);
-- CREATE OR REPLACE VIEW keeps the column list, types and grants (it fails if any changed).
--
-- REVERT: re-apply the previous definition (20261010162049_audit_20261010_pack_table_rows_reads_topshot_supply_from_atlas.sql),
--   or run this file's DO block with a1_old / a1_new swapped.

DO $mig$
DECLARE
  v_def text;
  v_new text;
  a1_old constant text := $x$ AND (EXISTS ( SELECT 1
           FROM pack_drop_pool dp
          WHERE dp.collection_id = pd.collection_id AND dp.dist_id = pd.dist_id)) AND $x$;
  a1_new constant text := $x$ AND ((EXISTS ( SELECT 1
           FROM pack_drop_pool dp
          WHERE dp.collection_id = pd.collection_id AND dp.dist_id = pd.dist_id)) OR (EXISTS ( SELECT 1
           FROM pack_container_recipes cr
          WHERE cr.collection_id = pd.collection_id AND cr.container_dist_id = pd.dist_id))) AND $x$;
BEGIN
  v_def := pg_get_viewdef('public.pack_table_rows'::regclass, true);
  v_new := v_def;
  IF (length(v_new) - length(replace(v_new, a1_old, ''))) / length(a1_old) <> 1 THEN RAISE EXCEPTION 'anchor a1 not unique'; END IF;
  v_new := replace(v_new, a1_old, a1_new);
  EXECUTE 'CREATE OR REPLACE VIEW public.pack_table_rows AS ' || v_new;
END
$mig$;
