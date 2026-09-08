-- 20260908003056_audit_20260907_refresh_atlas_pack_ev_writes_real_supply_not_a_fabricated_zero
--
-- refresh_atlas_pack_ev() computed `is_positive_ev` carefully — the snapshot
-- migration 20260816050000 documents EIGHT honesty properties guarding that one
-- boolean, because it is "the single boolean a collector reads as 'buying this
-- pack is worth it'" — and then its SUCCESS branch hardcoded two supply columns:
--
--     … LEAST((ev->>'edition_count')::int, 32767), 0, NULL, v_now);
--                                                  ↑   ↑
--                                    total_unopened   depletion_pct
--
-- `pack_ev_latest` then OVERRIDES the flag the function just computed:
--
--     WHEN h.total_unopened IS NOT NULL AND h.total_unopened <= 0
--          OR h.depletion_pct IS NOT NULL AND h.depletion_pct >= 100 THEN false
--     ELSE h.is_positive_ev
--
-- The view's rule is CORRECT — a sold-out pack cannot be +EV. The writer fed it
-- a fabricated `0` meaning "I did not compute this", and the view read it as
-- "sold out". ⭐ This is the `?? 0` shape CLAUDE.md names as the platform's top
-- defect class, one table apart: an unknown published as a measured zero, with a
-- downstream consumer acting on it.
--
-- ⚠ The eight documented properties do NOT cover this. Property 4 documents
-- `depletion_pct = 100` on the FAILURE branch and that is deliberate (a pack
-- whose EV cannot be computed must never publish a +EV badge). The SUCCESS
-- branch's `0` was undocumented, and it defeated properties 1-3 on every row it
-- wrote.
--
-- MEASURED LIVE 2026-09-07 17:2x PT, re-derived rather than quoted from the
-- filing (which measured 333 on 09-07 14:35 PT — the population GREW):
--
--     pack_ev_latest rows                                4,642
--     rows with total_unopened = 0 (this writer's)         573
--     …of those, is_positive_ev = true                       0
--     rows with total_unopened IS NULL (other writers)     100
--     …of those, is_positive_ev = true                      12
--
-- 573 rows, not one of them publishable as +EV; the 12 that ARE positive come
-- from writers that leave the column NULL. That is the falsifier this fix is
-- built on: if a row written here is ever seen `is_positive_ev = true` while
-- `total_unopened = 0`, the mechanism described above is wrong.
--
-- THE DATA WAS ALREADY IN THE JOINED ROW. `pack_distributions` is joined as
-- `pd` in the driving cursor and carries `total_sealed` / `depletion_pct`.
-- Measured over the 57 atlas-walked distributions (pd fresh 2026-09-08 00:13Z):
-- total_sealed > 0 on 57 of 57, NULL on 0, and depletion_pct populated on all
-- 57 with 3 genuinely at >= 100. So the fabricated `0` was not merely unknown —
-- it was WRONG on every row, and it mislabelled 54 available packs as sold out
-- while getting the 3 genuinely-depleted ones right for the wrong reason.
--
-- ⛔ COUNTERFACTUAL TODAY IS ZERO, AND THAT IS WHY THIS IS WORTH SHIPPING NOW
-- RATHER THAN LOOKING URGENT. No atlas-walked pack currently has
-- `gross_ev > pack_price`, so no user-visible row changes today. This is a
-- LATENT correctness fix: it guarantees the +EV board stays empty for this lane
-- even when a genuinely +EV pack appears, and it bites exactly when the pack
-- pool is repopulated (inbox 2026-09-07T1603Z: the atlas pool is a
-- 57-distribution seed last refreshed 2026-07-17). Shipping it while the
-- counterfactual is zero is the SAFE window, not a reason to defer.
--
-- WHAT CHANGES — success branch only, two values:
--   * the cursor SELECT gains `pd.total_sealed, pd.depletion_pct`
--   * the success INSERT writes `r.total_sealed, r.depletion_pct` in place of
--     the literals `0, NULL`
--
-- ⭐ NULL PASSES THROUGH DELIBERATELY. When `pd.total_sealed` is unknown the
-- function now writes NULL, and the view treats NULL as "unknown", not as
-- "sold out" — that is the honest three-state answer, and it is exactly why the
-- other writers' 100 NULL rows can still be +EV. Do NOT COALESCE this to 0;
-- that would restore the defect in a shape the guard below cannot see.
--
-- ⚠ THE FAILURE BRANCH IS UNTOUCHED. Its `0, 100` is property 4 and is correct:
-- an uncomputable pack must be unable to publish a +EV badge.
--
-- ⚠ SELECT DISTINCT SAFETY, checked structurally rather than by today's data:
-- adding two pd columns to a SELECT DISTINCT could multiply rows if a
-- (collection_id, dist_id) had several pd rows. It cannot —
-- `pack_distributions_dist_collection_unique` is a UNIQUE index on
-- (dist_id, collection_id), so pd contributes exactly one row per key. The pin's
-- "swept ONCE" assertion covers the pool side and still passes.
--
-- ⚠ TYPES MATCH WITH NO CAST: pack_ev_history.total_unopened is `integer` and
-- pack_distributions.total_sealed is `integer`; both depletion_pct columns are
-- `smallint`. No clamp is needed and none is added (unlike edition_count, whose
-- LEAST(..., 32767) guard stays).
--
-- PIN: supabase/tests/refresh_atlas_pack_ev.sql carries this body verbatim and
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift, so the pin's
-- verbatim block and its PINS `migration:` entry move to this file in the same
-- commit. The pin's fixture gained real `total_sealed` / `depletion_pct` values
-- (a column-level fixture audit, per the repo rule for repointing a DB pin —
-- without it the new reads resolve to NULL and the test proves nothing), and it
-- gained the assertion that was MISSING and let this defect hide: that the
-- success branch publishes REAL supply. `total_unopened` was asserted nowhere in
-- the pin before this commit.
--
-- anon-exec: unchanged — refresh_atlas_pack_ev already exists and this is a
-- CREATE OR REPLACE, which does NOT reset a function ACL, so a REVOKE here would
-- CHANGE production rather than describe it. Verified live AFTER this migration
-- applied, with has_function_privilege rather than the acl text:
-- anon EXECUTE = false, authenticated EXECUTE = false, prosecdef = true, and
-- check_secdef_anon_exec_drift() returns a jsonb array of LENGTH 0 (read the
-- array length — that function returns one row whether or not it is clean).
--
-- REVERT: re-apply the body from
-- supabase/migrations/20260816050000_audit_20260816_snapshot_refresh_atlas_pack_ev.sql
-- (restores the literals `0, NULL`), revert the pin file and the PINS entry with
-- it, and let the hourly pg_cron job `rpc-atlas-pack-ev` (jobid 217) rewrite the
-- rows on its next tick — pack_ev_history is append-per-hour and pack_ev_latest
-- reads the newest row, so no data needs unwinding.

CREATE OR REPLACE FUNCTION public.refresh_atlas_pack_ev()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cid uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r record;
  ev jsonb;
  v_gross numeric;
  v_typical numeric;
  v_written int := 0;
  v_now timestamptz := now();
BEGIN
  FOR r IN
    SELECT DISTINCT p.dist_id,
           pd.metadata->>'uuid' AS listing_uuid,
           COALESCE(pd.title, pd.metadata->>'name') AS title,
           GREATEST(COALESCE((pd.metadata->>'number_of_pack_slots')::int, 1), 1) AS slots,
           pas.lowest_ask,
           pd.total_sealed,
           pd.depletion_pct
    FROM pack_drop_pool p
    JOIN pack_distributions pd ON pd.collection_id = v_cid AND pd.dist_id = p.dist_id
    LEFT JOIN pack_ask_state pas ON pas.collection_slug = 'nba-top-shot' AND pas.dist_id = p.dist_id
                                 AND pas.is_listed IS TRUE AND pas.lowest_ask > 0
    WHERE p.collection_id = v_cid AND p.pool_source = 'atlas'
  LOOP
    ev := public.compute_pack_ev_per_edition_weighted(v_cid, r.dist_id, COALESCE(r.lowest_ask, 0), r.slots);
    IF (ev->>'ok')::boolean IS NOT TRUE THEN
      INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
        primary_price, secondary_ask, price_source, primary_available, secondary_available,
        gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
      VALUES (r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask,0),
        NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
        false, r.lowest_ask > 0, 0, NULL, 0, false, NULL, NULL, 0, 0, 100, v_now);
      v_written := v_written + 1;
      CONTINUE;
    END IF;
    v_gross := (ev->>'gross_ev')::numeric;
    v_typical := (ev->>'typical_pull_ev')::numeric;
    INSERT INTO pack_ev_history (pack_listing_id, collection_id, dist_id, pack_name, pack_price,
      primary_price, secondary_ask, price_source, primary_available, secondary_available,
      gross_ev, typical_ev, pack_ev, is_positive_ev, value_ratio, fmv_coverage_pct, edition_count, total_unopened, depletion_pct, snapshotted_at)
    VALUES (
      r.listing_uuid, v_cid, r.dist_id, r.title, COALESCE(r.lowest_ask, 0),
      NULL, r.lowest_ask, CASE WHEN r.lowest_ask > 0 THEN 'secondary' ELSE 'none' END,
      false, r.lowest_ask > 0,
      v_gross, v_typical,
      round(v_gross - COALESCE(r.lowest_ask, 0), 2),
      (r.lowest_ask > 0 AND (v_gross - r.lowest_ask) > 0),
      CASE WHEN r.lowest_ask > 0 THEN round(v_gross / r.lowest_ask, 3) ELSE NULL END,
      (ev->>'fmv_coverage_pct')::smallint, LEAST((ev->>'edition_count')::int, 32767), r.total_sealed, r.depletion_pct, v_now);
    v_written := v_written + 1;
  END LOOP;

  PERFORM public.log_pipeline_run('topshot-atlas-pack-ev', v_now, v_written, v_written, 0, true, NULL,
    'nba-top-shot', NULL, NULL, jsonb_build_object('rows', v_written));
  RETURN jsonb_build_object('ok', true, 'written', v_written, 'finished_at', now());
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'written', v_written);
END;
$function$;
