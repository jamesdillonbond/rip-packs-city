-- audit_20261109_candy_delete_orphan_name_only_editions
--
-- WHY. 2026-11-09 ~8:50 PM PT (Claude Code cloud; Trevor: "Fetch it. We want data accuracy", then
-- "keep going ... completing all you're able to do"). DAS returned some Candy assets without their
-- off-chain JSON and the census keyed them from the on-chain name alone: 4,844 NAME-ONLY editions
-- (tier, player_name, thumbnail_url NULL, circulation 0/NULL) held by 328,317 cards in 9,114 wallets.
-- Since 28720979f the census fetches each asset's metadata and repoints the card to its real edition;
-- at 8:40 PM PT 242,768 cards were left and 1,044 name-only editions had NO holder. Nothing removes
-- them: candy_delete_orphan_one_of_one_editions (20261110041400) covers circulation-1 editions only.
--
-- WHAT. candy_delete_orphan_name_only_editions(p_limit): deletes a Candy name-only edition only when
-- no card holds it, it is older than a day, and no user, market, price or trophy row names it
-- (wishlists, watchlist, candy offers / listings, Candy sales, FMV snapshots, trophy_moments by id or
-- key, pack pool, special serials, a candy_edition_market_daily row CARRYING data). Measured before
-- writing: of the 1,044 unheld, 0 are named by sales / fmv_snapshots / edition_fmv_current /
-- edition_fmv_estimates / candy_listings / candy_offers / trophy_moments / cached_listings_v2 /
-- price_snapshots / market_edition_badges / portfolio_moments / pack_open_pulls / moments; all 1,044
-- have one 11-09 candy_edition_market_daily row (the writer snapshots every Candy edition, no FK),
-- 1 of which carries data — that one is skipped. An edition's EMPTY snapshot rows are removed with it
-- in the same subtransaction. A NO ACTION FK reference raises and is counted, never forced. Logs
-- pipeline_runs 'candy-orphan-name-only-editions' (rows_written = editions deleted). Hourly at :37
-- (the 1/1 cleanup is :22, the census :57).
--
-- ALSO: candy_repoint_listings_to_card_edition(p_mints) — a Candy listing follows its card. Called by
-- the census right after it repoints cards (lib/candy/collections-census.ts): every candy_listings row
-- for those token_mints moves to the edition the card's newest holdings row names. Closes inbox
-- 2026-11-10T0430Z (retired asks kept a re-keyed card's OLD edition, blocking the orphan cleanup).
-- Measured 8:55 PM PT: 0 of 8,301 listings currently differ from their card's edition (the 11 found
-- on 11-09 were moved one-off, bb11953c5), so this changes nothing today; it keeps it that way.
--
-- PIN: supabase/tests/candy_delete_orphan_name_only_editions.sql and
--   supabase/tests/candy_repoint_listings_to_card_edition.sql (functions verbatim; drift guard).
-- anon-exec: revoked (candy_delete_orphan_name_only_editions, candy_repoint_listings_to_card_edition) — REVOKE FROM PUBLIC, anon, authenticated
--   below; pg_cron runs as the owner.
-- Revert: DROP FUNCTION public.candy_repoint_listings_to_card_edition(text[]) (after the census commit
--   that calls it is reverted); SELECT cron.unschedule('rpc-candy-orphan-name-only-editions');
--   DROP FUNCTION public.candy_delete_orphan_name_only_editions(integer);
--   Deleted rows were unheld and unreferenced; the census never re-creates a name-only edition
--   (an unhydrated card is fetched or skipped, never written under a name-only key).

CREATE OR REPLACE FUNCTION public.candy_delete_orphan_name_only_editions(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_candy      constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_candidates int := 0;
  v_deleted    int := 0;
  v_referenced int := 0;
  v_daily      int := 0;
  v_n          int;
  r            record;
BEGIN
  -- A NAME-ONLY Candy edition no card holds any more. DAS returned some assets without their
  -- off-chain JSON and the census keyed them from the on-chain name alone: no tier, no player,
  -- no image, no circulation (4,844 editions, 328,317 cards on 2026-11-09). Since then the
  -- census fetches the metadata and REPOINTS each card to its real edition
  -- (lib/chains/solana/hydrate.ts), leaving the name-only editions with no holder.
  -- Only rows older than a day: a census page inserts an edition just before its holdings.
  -- Skipped outright: anything a user row (CASCADE / SET NULL) or a market / price / trophy row
  -- names — a sale, FMV, listing, offer or trophy on a name-only edition is a finding to read,
  -- not something to delete under. The daily market snapshot writes a row for EVERY Candy
  -- edition; an EMPTY one is removed with the edition, one carrying data skips it. A NO ACTION
  -- reference raises and is counted, never forced.
  FOR r IN
    SELECT e.id
      FROM public.editions e
     WHERE e.collection_id = v_candy
       AND e.tier IS NULL
       AND e.player_name IS NULL
       AND e.thumbnail_url IS NULL
       AND coalesce(e.circulation_count, 0) = 0
       AND e.created_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                        WHERE w.collection_id = e.collection_id AND w.edition_key = e.external_id)
       AND NOT EXISTS (SELECT 1 FROM public.user_wishlists x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.watchlist_items x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.candy_offers x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.candy_listings x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.sales x WHERE x.collection_id = v_candy AND x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.fmv_snapshots x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.trophy_moments x WHERE x.edition_id IN (e.id::text, e.external_id))
       AND NOT EXISTS (SELECT 1 FROM public.pack_drop_pool x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.special_serial_holders x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.special_serial_lookup_failures x WHERE x.edition_id = e.id)
       AND NOT EXISTS (SELECT 1 FROM public.candy_edition_market_daily d
                        WHERE d.edition_id = e.id
                          AND (d.floor_ask_usd IS NOT NULL OR coalesce(d.listed_count, 0) > 0
                               OR d.best_offer_usd IS NOT NULL OR coalesce(d.offer_count, 0) > 0))
     ORDER BY e.created_at, e.id
     LIMIT GREATEST(coalesce(p_limit, 500), 0)
  LOOP
    v_candidates := v_candidates + 1;
    BEGIN
      DELETE FROM public.candy_edition_market_daily WHERE edition_id = r.id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      DELETE FROM public.editions WHERE id = r.id;
      v_deleted := v_deleted + 1;
      v_daily := v_daily + v_n;
    EXCEPTION WHEN foreign_key_violation THEN
      v_referenced := v_referenced + 1;
    END;
  END LOOP;

  -- rows_written = editions actually deleted; a referenced row is reported, not hidden.
  PERFORM public.log_pipeline_run(
    'candy-orphan-name-only-editions', v_started,
    v_candidates, v_deleted, v_referenced,
    true, NULL, 'candy_mlb', NULL, NULL,
    jsonb_build_object('candidates', v_candidates, 'deleted', v_deleted, 'referenced', v_referenced,
                       'empty_daily_snapshots_deleted', v_daily, 'limit', p_limit));
  RETURN jsonb_build_object('ok', true, 'candidates', v_candidates, 'deleted', v_deleted,
                            'referenced', v_referenced, 'empty_daily_snapshots_deleted', v_daily);
END
$function$;

CREATE OR REPLACE FUNCTION public.candy_repoint_listings_to_card_edition(p_mints text[])
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A Candy listing follows its CARD: when the census repoints a card to its real edition (a
  -- name-only key fixed, or a 1-of-1 re-keyed by asset id), every candy_listings row for that
  -- token_mint (Magic Eden and OpenSea, active or retired) moves to the edition the card's NEWEST
  -- holdings row names. A retired ask is never re-upserted by its indexer, so without this its
  -- edition never moved and the orphan cleanups could not retire the old edition (inbox
  -- 2026-11-10T0430Z: 11 rows on 11-09). Returns rows moved.
  WITH cur AS (
    SELECT DISTINCT ON (w.moment_id) w.moment_id, e.id AS edition_id
      FROM public.wallet_moments_cache w
      JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
     WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND w.moment_id = ANY (p_mints)
     ORDER BY w.moment_id, w.last_seen_at DESC NULLS LAST
  ), moved AS (
    UPDATE public.candy_listings l
       SET edition_id = cur.edition_id
      FROM cur
     WHERE l.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
       AND l.token_mint = cur.moment_id
       AND l.edition_id IS DISTINCT FROM cur.edition_id
    RETURNING 1
  )
  SELECT count(*)::int FROM moved
$function$;

REVOKE EXECUTE ON FUNCTION public.candy_repoint_listings_to_card_edition(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_repoint_listings_to_card_edition(text[]) TO service_role;

REVOKE EXECUTE ON FUNCTION public.candy_delete_orphan_name_only_editions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_delete_orphan_name_only_editions(integer) TO service_role;

SELECT cron.schedule('rpc-candy-orphan-name-only-editions', '37 * * * *',
  $cron$SELECT public.candy_delete_orphan_name_only_editions(500)$cron$);

DO $mig$
BEGIN
  IF has_function_privilege('anon', 'public.candy_delete_orphan_name_only_editions(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.candy_delete_orphan_name_only_editions(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.candy_repoint_listings_to_card_edition(text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.candy_repoint_listings_to_card_edition(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked on a Candy cleanup function';
  END IF;
END
$mig$;
