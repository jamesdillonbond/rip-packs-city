-- audit_20260913_onchain_rekey_stops_downgrading_a_parallel_to_its_base_on_absence_of_evidence
--
-- 🚨 A CONFIRMED CORRECTNESS DEFECT IN A DAILY JOB THAT REWRITES NFT IDENTITY, AND THE REPO
-- ALREADY CONTAINS THE CORRECT RULE — in another function, written down, with the reasoning.
--
-- `remap_topshot_from_onchain_map()` (pg_cron `rpc-topshot-onchain-rekey`, jobid 434, 04:33 PT
-- daily) resolves each mapped nft's target edition as `COALESCE(epar.id, ebase.id)`, where the
-- PARALLEL leg `epar` exists only when `topshot_moment_subeditions` carries a POSITIVE
-- `subedition_id`. When that row is missing the target silently collapses to the BASE edition —
-- and the sales re-key then moves a sale that was already sitting on the correct PARALLEL down
-- to that base. ⭐ **A missing subeditions row is absence of evidence; this function was reading
-- it as evidence of absence.** That is the failed-read-published-as-fact shape this repo is
-- built around, one layer below any surface: nothing renders an error, a Moment simply starts
-- displaying under the wrong edition.
--
-- ── THE REPO'S OWN RULE, WHICH THIS FUNCTION WAS VIOLATING ────────────────────────────────────
-- `remap_topshot_parallel_to_base_misattributed()` does exactly this job and requires EVIDENCE.
-- Its pin says so verbatim: a parallel sale moves to base when "(a) the moment is a known base
-- (subedition_id=0) OR (b) it is NOT a known parallel AND its serial overflows the parallel's
-- circulation while fitting the base's", and "**A legitimate parallel sale, a serial that fits
-- the parallel, or a base that can't cover the serial are all LEFT ALONE.**" That function is
-- live and daily — `/api/cron/refresh-conflated-editions` calls it (ran 08:17 PT today) — so
-- removing the downgrade here creates NO capability gap. It removes a duplicate of the job that
-- is done properly elsewhere.
--
-- ── MEASURED BLAST RADIUS (2026-09-13, live) ─────────────────────────────────────────────────
-- `audit_topshot_sale_drain_remap_20260621` is written by this function and NO OTHER (checked
-- against every function in `public`), and every downgrade row is stamped 04:33:00 PT — jobid
-- 434, attribution settled rather than assumed.
--
--   audit rows, all time ................................. 26,400
--   base → parallel (the intended repair) ................. 7,958
--   parallel → its own base (this defect) ................... 140
--   by month: Jun 1 · Jul 1 · Aug 2 · Sep 136
--   ⚠ Sep is NOT a trend — 134 of the 136 landed in ONE run on 2026-09-09; 09-08 and 09-11
--     contributed one each. A monthly rollup read as 70× growth; the daily split refutes that.
--
-- ⭐ **THE DECISIVE TEST IS THE OTHER FUNCTION'S OWN CRITERIA, APPLIED TO THE 09-09 COHORT
-- (124 distinct nfts, 330 sales rows):**
--
--   known base (subedition_id = 0), i.e. condition (a) ......... 0 of 124
--   serial FITS the parallel's circulation .................. 124 of 124
--   serial overflows the parallel, i.e. condition (b) ........... 0 of 124
--   parallel circulation unknown ................................ 0 of 124
--
-- **Every one of the 124 fails both conditions, so the evidence-bearing function would have left
-- every one of them alone.** None has been restored: all 330 sales rows still sit on the base.
-- (The inverse repair `remap_topshot_base_keyed_parallel_sales()` did not pick them up.)
--
-- ── WHAT THIS CHANGES ────────────────────────────────────────────────────────────────────────
-- `_tgt` gains two derived columns — `new_ext` (the target edition's external_id) and
-- `known_base` (does a `subedition_id = 0` row exist for this nft) — and all THREE write paths
-- (the sales audit INSERT, the sales UPDATE, the moments `_mv` build) gain the identical guard:
--
--   skip the row when it is currently on a PARALLEL whose base is the very target we computed,
--   AND nothing positively says the moment is a base.
--
-- ⚠ **The guard is spelled identically in all three places on purpose.** The audit INSERT and the
-- UPDATE must select the same rows or the audit stops describing what happened — an audit that
-- over-reports is worse than none, because the revert path is built from it. Both use the same
-- `EXISTS` subquery form rather than one using a join and the other a subquery.
--
-- ⓘ What the guard does NOT block, deliberately: a re-key to a DIFFERENT base (split_part of the
-- current parallel ≠ `new_ext`), a re-key where the target IS a parallel, a serial-only change,
-- and the downgrade when `subedition_id = 0` positively says the moment is a base. The pin
-- asserts all four so a future simplification cannot quietly widen it back.
--
-- ⚠ THIS CHANGES A PINNED, DOCUMENTED INVARIANT. The pin's header opened with "SALES are re-keyed
-- unconditionally — there is no uniqueness to protect." That sentence is now false and is
-- rewritten in the same commit; the asymmetry it was describing (sales unconditional vs moments
-- free-slot-only) survives in every other respect.
--
-- ── VERIFIED BEFORE APPLYING ─────────────────────────────────────────────────────────────────
-- Run against the pin's fixtures in a local PG 16: all pre-existing assertions still pass, and
-- six new ones cover every branch of the guard. ⭐ MUTATION CONTROL, both halves: with the OLD
-- body the pin FAILS — `sales_rekeyed` reads 5 against 4, and with that relaxed,
-- `moments_rekeyed` reads 3 against 2. The new assertions are not vacuous.
--
-- ── BODY PROVENANCE ──────────────────────────────────────────────────────────────────────────
-- Built from the LIVE `pg_get_functiondef` body (75 lines), verified pin == live first, and
-- verified mechanically after editing: every one of the 75 original lines appears in the new
-- body in order, four of them carrying only the intended punctuation change, plus exactly 18
-- added lines. Nothing else was touched.
--
-- ── REVERT ───────────────────────────────────────────────────────────────────────────────────
-- Re-apply the body from `20260815163000_audit_20260815_snapshot_remap_topshot_from_onchain_map.sql`
-- verbatim (it is the unguarded version). No schema, no data change in this migration.
-- ⚠ The 330 already-downgraded sales rows are NOT repaired here — that is a separate, audited
-- data change, and it must land AFTER this guard or the 04:33 PT run puts them back on base.
--
-- anon-exec: intentional — no REVOKE for remap_topshot_from_onchain_map here because this is a
-- same-signature CREATE OR REPLACE, which does not reset a function ACL. Verified live BEFORE
-- this migration (anon EXECUTE false, authenticated false, service_role true) and re-verified
-- after with has_function_privilege rather than acl text.

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
         COALESCE(epar.id, ebase.id) AS new_edition_id,
         COALESCE(epar.external_id, ebase.external_id) AS new_ext,
         EXISTS (SELECT 1 FROM topshot_moment_subeditions sb
                  WHERE sb.nft_id = m.nft_id AND sb.subedition_id = 0) AS known_base
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
    AND (s.edition_id <> t.new_edition_id OR s.serial_number IS DISTINCT FROM t.new_serial)
    AND NOT (t.known_base IS NOT TRUE
             AND EXISTS (SELECT 1 FROM editions ecur
                          WHERE ecur.id = s.edition_id
                            AND ecur.external_id LIKE '%::%'
                            AND split_part(ecur.external_id, '::', 1) = t.new_ext));

  UPDATE sales s
  SET edition_id = t.new_edition_id,
      serial_number = COALESCE(t.new_serial, s.serial_number)
  FROM _tgt t
  WHERE s.nft_id = t.nft_id AND s.collection_id = v_ts AND t.new_edition_id IS NOT NULL
    AND (s.edition_id <> t.new_edition_id OR s.serial_number IS DISTINCT FROM t.new_serial)
    AND NOT (t.known_base IS NOT TRUE
             AND EXISTS (SELECT 1 FROM editions ecur
                          WHERE ecur.id = s.edition_id
                            AND ecur.external_id LIKE '%::%'
                            AND split_part(ecur.external_id, '::', 1) = t.new_ext));
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  -- ── MOMENTS re-key (safe, free-slot only) ──
  DROP TABLE IF EXISTS _mv;
  CREATE TEMP TABLE _mv ON COMMIT DROP AS
  SELECT m.id AS moment_pk, m.nft_id, m.edition_id AS old_ed, m.serial_number AS old_ser,
         t.new_edition_id AS new_ed, COALESCE(t.new_serial, m.serial_number) AS new_ser
  FROM moments m JOIN _tgt t ON t.nft_id = m.nft_id
  WHERE m.collection_id = v_ts AND t.new_edition_id IS NOT NULL
    AND (m.edition_id <> t.new_edition_id OR m.serial_number IS DISTINCT FROM COALESCE(t.new_serial, m.serial_number))
    AND NOT (t.known_base IS NOT TRUE
             AND EXISTS (SELECT 1 FROM editions ecur
                          WHERE ecur.id = m.edition_id
                            AND ecur.external_id LIKE '%::%'
                            AND split_part(ecur.external_id, '::', 1) = t.new_ext));
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
