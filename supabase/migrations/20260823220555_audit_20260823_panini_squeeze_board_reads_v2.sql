-- Cutover step 2a: point panini_squeeze_board at the one-pass MV.
-- Deliberately NOT bundled with the DROP of the old MV: jobid 353 fires at :18/:48 and
-- a REFRESH ... CONCURRENTLY holds a lock for ~234 s, which would block a DROP in the
-- same transaction. Repointing the view takes no lock on the old MV, so this is safe to
-- run at any moment; the DROP follows in its own migration.
--
-- Equivalence verified against the live MV immediately before this, all 4,684 rows,
-- ids matched 4,684/4,684:
--   is_rookie                    0 diffs   <- a column this rewrite CHANGES
--   is_debut                     0 diffs   <- a column this rewrite CHANGES
--   serials_with_recorded_price  3 diffs   <- all 3 have panini_card_serials.captured_at
--                                             AFTER the 21:48:00Z refresh (21:48:19,
--                                             21:57:00, 22:00:00), all deltas positive
--   fmv_usd                     14 diffs   <- byte-identical lateral in both bodies
--   17 untouched passthrough cols 11 diffs <- 11 of 11 have panini_editions.updated_at
--                                             AFTER 21:48:00Z (21:48:19 .. 21:58:12)
-- Every difference is ingest drift in the 24-minute comparison window (panini-ingest
-- runs 840x/day). Zero differences are attributable to the rewrite.
--
-- ⚠ CREATE OR REPLACE VIEW RESETS reloptions — that is exactly how migration
-- 20260815153324 silently dropped security_invoker from the deals board and tripped
-- view_unexpected_definer hours later. The ALTER below is mandatory, not decorative,
-- and is in the SAME transaction so no window exists where this view is SECDEF.
--
-- REVERT:
--   CREATE OR REPLACE VIEW public.panini_squeeze_board AS
--     SELECT id, external_id, collection_id, player_name, nation, set_name, parallel,
--            parallel_family, rarity_label, tier, mint_cap, pulled_count, still_in_packs,
--            rip_pct, is_fotl_exclusive, is_rookie, is_debut, fmv_usd,
--            sealed_fmv_exposure_usd, fmv_confidence, serial_low_ask_usd, thumbnail_url,
--            serials_with_recorded_price, coverage_flag
--     FROM mv_panini_squeeze m;
--   ALTER VIEW public.panini_squeeze_board SET (security_invoker = on);
CREATE OR REPLACE VIEW public.panini_squeeze_board AS
 SELECT id,
    external_id,
    collection_id,
    player_name,
    nation,
    set_name,
    parallel,
    parallel_family,
    rarity_label,
    tier,
    mint_cap,
    pulled_count,
    still_in_packs,
    rip_pct,
    is_fotl_exclusive,
    is_rookie,
    is_debut,
    fmv_usd,
    sealed_fmv_exposure_usd,
    fmv_confidence,
    serial_low_ask_usd,
    thumbnail_url,
    serials_with_recorded_price,
    coverage_flag
   FROM mv_panini_squeeze_v2 m;

ALTER VIEW public.panini_squeeze_board SET (security_invoker = on);