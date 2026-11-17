-- deep-audit D13 — /disney-pinnacle/overview reported FMV figures derived from an
-- ASK feed on a superseded table, and flagged itself broken while the real data
-- was hours old.
--
-- get_collection_stats(text)'s Pinnacle arm read `pinnacle_editions` and filled
-- the FMV outputs from the ASK columns:
--
--     COUNT(*) FILTER (WHERE ask_price IS NOT NULL)  -> v_fmv_covered
--     ROUND(100.0 * … / v_edition_count, 1)          -> v_fmv_pct
--     MAX(ask_updated_at)                            -> v_fmv_last_at
--     v_fmv_age_minutes := NOW() - v_fmv_last_at     -- age of an ASK feed, labelled FMV
--
-- `pinnacle_editions.ask_*` was superseded ~2026-07-17 by `pinnacle_catalog` and
-- has not been written since. Measured live 2026-08-09:
--
--   surface said            source                         reality
--   ----------------------  -----------------------------  -----------------------------
--   28% "FMV coverage"      ask_price IS NOT NULL (328)    366/527 = 69.4% have real FMV
--   "FMV DATA AGE 23D"      max(ask_updated_at) 2026-07-17 max(fmv_computed_at) = 4.6h
--   PIPELINE STATUS OUTDATED                               every Pinnacle pipeline healthy
--
-- ⚠ The original audit filing ("the pinnacle-2.0.0-render recompute appears dead")
-- was WRONG and the addendum corrected it. The pipelines were never the problem:
-- over 7 days pinnacle-fmv-recalc wrote 27,620 rows, pinnacle-listings-indexer
-- 3,806, pinnacle-catalog-floor-refresh 63,499, and pinnacle_fmv_history is 4.6h
-- old. The page was UNDERSTATING our own data quality and calling itself broken —
-- the pessimistic direction of the "instrument lies about its own state" class.
--
-- ⚠ SCOPE — deliberately NOT changing the denominator. `pinnacle_editions` is
-- EDITION-grain (527) and `pinnacle_catalog` is RENDER-grain (2,457). Swapping
-- v_edition_count 527 -> 2,457 would move a public headline by 4.7x and is exactly
-- the merged-denominator error tracked as D20. So the numerator is bridged onto the
-- EXISTING grain via `pinnacle_catalog.legacy_edition_key`, keeping numerator and
-- denominator on the same basis: 366 of 527 legacy editions map to a catalog row
-- carrying an fmv_usd = 69.4%. Resolving the grain question, and repointing
-- edition_count / sniper_deals / top_sales / tier_breakdown, stays a separate
-- coherent change (D13b) — the all-$1 "cheapest asks" on that page are the same
-- stale ask feed (140 of the 328 legacy asks are exactly $1, the documented
-- uniform-$1 Flowty artifact) and are NOT fixed here.
--
-- Unambiguous regardless of grain: an FMV age must come from an FMV timestamp.
-- max(fmv_computed_at) in pinnacle_catalog and max(computed_at) in
-- pinnacle_fmv_history agree at 4.6h.
--
-- Applied by textual substitution on the live definition rather than by
-- re-transcribing a ~200-line function, so nothing else in the body can drift.
-- Targets the (text) overload only — the (uuid) overload has no Pinnacle arm.
-- Asserts the substitution actually happened, and is idempotent.
--
-- Verified after apply: Pinnacle 527 editions / 366 covered / 69.4% / FMV age 4.7h.
-- Other collections unchanged (Top Shot 19,667 / 82.2%, All Day 6,190 / 84.3%).
--
-- REVERT: replay the definition substituting the block back to
--   COUNT(*) FILTER (WHERE ask_price IS NOT NULL) … MAX(ask_updated_at) FROM pinnacle_editions;

DO $mig$
DECLARE
  def   text;
  newdef text;
  old_block text := 'SELECT
      COUNT(*) FILTER (WHERE ask_price IS NOT NULL),
      ROUND(100.0 * COUNT(*) FILTER (WHERE ask_price IS NOT NULL) / NULLIF(v_edition_count, 0), 1),
      NULL::numeric,
      MAX(ask_updated_at)
    INTO v_fmv_covered, v_fmv_pct, v_fmv_age_minutes, v_fmv_last_at
    FROM pinnacle_editions;';
  new_block text := 'SELECT
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM pinnacle_catalog pc
         WHERE pc.legacy_edition_key = pe.edition_key AND pc.fmv_usd IS NOT NULL)),
      ROUND(100.0 * COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM pinnacle_catalog pc
         WHERE pc.legacy_edition_key = pe.edition_key AND pc.fmv_usd IS NOT NULL))
        / NULLIF(v_edition_count, 0), 1),
      NULL::numeric,
      (SELECT MAX(pc2.fmv_computed_at) FROM pinnacle_catalog pc2)
    INTO v_fmv_covered, v_fmv_pct, v_fmv_age_minutes, v_fmv_last_at
    FROM pinnacle_editions pe;';
BEGIN
  SELECT pg_get_functiondef('public.get_collection_stats(text)'::regprocedure) INTO def;

  IF position(new_block in def) > 0 THEN
    RAISE NOTICE 'already repointed to FMV, skipping';
    RETURN;
  END IF;

  IF position(old_block in def) = 0 THEN
    RAISE EXCEPTION
      'PRECONDITION FAILED: the ask-derived FMV block was not found verbatim in get_collection_stats(text) — someone changed it; re-measure before repointing';
  END IF;

  newdef := replace(def, old_block, new_block);
  EXECUTE newdef;
END
$mig$;
