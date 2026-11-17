-- 2026-07-29 — make remap_topshot_split_resolved_subeditions' LIMIT bind on rows
-- that actually need splitting. Same defect + same fix as the 2026-07-27
-- `audit_20260727_nem_from_sales_limit_binds_on_derivable_rows` (green-while-blind).
--
-- BEFORE: the `_split` candidate temp table selected from topshot_moment_subeditions
-- with `LIMIT greatest(1, p_limit)` and NO predicate testing whether the row still
-- sits on the base edition. That table holds 673,195 rows, ~99% of which were split
-- long ago, so an 8,000-row arbitrary (physical-order) sample contained almost no
-- actionable work: the nightly drain reported wmc_split 0/1/2 while 82,272 wmc rows
-- sat ready to move (target ::subID edition already exists for 82,272 of 82,273).
-- The step looked healthy — it returned a plausible small number and never errored.
--
-- AFTER: the candidate CTE requires the nft to still be keyed to the BASE edition in
-- at least one of wmc / moments / sales, so the LIMIT bounds ACTIONABLE rows.
-- OR-branches are ordered cheapest-and-most-selective first (wmc carries the 82k
-- backlog and short-circuits most rows before the 8-partition sales probe).
--
-- Semantics of what MOVES are unchanged: identical eligibility (subedition_id > 0,
-- both editions exist), identical _split_collide knot guard, identical UPDATEs and
-- identical audit rows into audit_20260704_subedition_split_remap. Only candidate
-- SELECTION changes — a row with no work was always a no-op.
--
-- Measured: candidate selection 6.9s for a full 8,000 actionable batch; a bounded
-- p_limit=200 verification run moved 170 wmc + 11 sales + 45 moments in 4.7s
-- (vs wmc_split 0/1/2 per night before), every spot-checked row matching on-chain.
--
-- Revert: restore the prior body (drop the AND ( EXISTS ... ) block from `_split`).
-- Data revert: audit_20260704_subedition_split_remap holds every (src, nft_id,
-- old_edition, new_edition, row_ref) move for replay-back.

CREATE OR REPLACE FUNCTION public.remap_topshot_split_resolved_subeditions(p_limit integer DEFAULT 8000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
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
