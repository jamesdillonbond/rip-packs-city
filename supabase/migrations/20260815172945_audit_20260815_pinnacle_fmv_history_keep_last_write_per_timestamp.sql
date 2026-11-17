-- pinnacle_fmv_history was silently DROPPING the ASK_ONLY revision.
--
-- MEASURED 2026-08-15: 715 of 2,480 priced pinnacle_catalog rows (776 when first
-- found) had a latest history row whose value the catalog never published. The split
-- is exact -- HIGH/MEDIUM/LOW/STALE differ on ZERO rows, ASK_ONLY on all of them --
-- and the max divergence was $2,974.47.
--
-- MECHANISM: pinnacle_fmv_recalc_render_all() writes each render TWICE in ONE
-- transaction -- the sales loop, then the ASK_ONLY pass (fmv_usd = floor_ask*0.90).
-- Because `NOW()` is TRANSACTION-STABLE both writes stamp the same fmv_computed_at,
-- so the second trigger firing collided on (render_id, computed_at) and
-- `DO NOTHING` threw the ASK_ONLY value away. History therefore kept step 1's
-- sales-derived number while the catalog -- and every surface reading it --
-- published step 2's floor-derived one.
--
-- USER IMPACT: get_edition_fmv_history reads this table, so a Pinnacle edition page
-- plotted a series whose most recent point was NOT the FMV shown on the same page.
--
-- FIX: keep the LAST write for a given (render_id, computed_at). Within one recalc
-- that is the ASK_ONLY pass, i.e. the value actually published -- which is what a
-- price history is supposed to record.
--
-- WHY DO UPDATE IS SAFE HERE (checked before applying, because it would otherwise be
-- able to overwrite genuine historical points): only TWO writers touch
-- pinnacle_catalog, and neither can trigger this outside a recalc transaction --
--   * pinnacle_catalog_set_floor_asks  -- never references fmv_usd, so the trigger's
--     WHEN clause (fmv_usd/fmv_confidence IS DISTINCT FROM) cannot fire for it;
--   * pinnacle_fmv_recalc_render_all   -- always sets fmv_computed_at = NOW().
-- There is no code-side writer of pinnacle_catalog.fmv_usd either (repo swept).
-- So a conflict on (render_id, computed_at) can ONLY mean "same render, same recalc
-- transaction" -- exactly the case being fixed.
--
-- VERIFIED AFTER APPLY, against the exact double-write the bug depends on: two
-- UPDATEs to one render in one transaction sharing a computed_at, inside a rolled
-- back subtransaction. History kept the SECOND (published) value; probe left zero
-- residue in pinnacle_catalog or pinnacle_fmv_history.
--
-- FORWARD-ONLY BY DESIGN: the 715 existing wrong rows are NOT rewritten. Rewriting
-- historical price records is a data mutation with no need -- the next recalc writes
-- a fresh row at a new timestamp, so each render's LATEST point (the one the page
-- contradicts) becomes correct on the next run, within ~12h at the current cadence.
--
-- REVERT: re-run this file with `DO UPDATE SET ...` replaced by `DO NOTHING`.

CREATE OR REPLACE FUNCTION public.pinnacle_catalog_fmv_history_capture()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.pinnacle_fmv_history (render_id, fmv_usd, fmv_confidence, fmv_sales_count_30d, computed_at)
  VALUES (NEW.render_id, NEW.fmv_usd, NEW.fmv_confidence, NEW.fmv_sales_count_30d, COALESCE(NEW.fmv_computed_at, now()))
  ON CONFLICT (render_id, computed_at) DO UPDATE
    SET fmv_usd             = EXCLUDED.fmv_usd,
        fmv_confidence      = EXCLUDED.fmv_confidence,
        fmv_sales_count_30d = EXCLUDED.fmv_sales_count_30d;
  RETURN NEW;
END;
$function$;
