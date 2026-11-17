-- audit_20261113_candy_alias_apply_casts_the_tier — 2026-11-13 ~4:45 PM PT (Claude Code cloud; the #247 alias move).
--
-- FINDING. The first tick of rpc-candy-edition-key-alias-apply (4:40 PM PT) failed: "COALESCE types tier_type and text
-- cannot be matched" — editions.tier is the tier_type enum, wallet_moments_cache.tier is text. The DB pin modelled both
-- as text, so it could not see it. Nothing moved (the statement failed as a whole).
-- FIX. coalesce(ce.tier::text, w.tier). The pin now declares editions.tier as tier_type.
-- Base: prosrc md5 cc9ea6c2d638b040943cc31d8b023382 (= the body in 20261114002600), asserted below.
-- anon-exec: unchanged (candy_apply_edition_key_aliases) — CREATE OR REPLACE keeps the existing ACL (revoked).
-- Revert: re-apply the body in 20261114002600 (it fails on every tick; unschedule the job instead).
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.candy_apply_edition_key_aliases(integer)'::regprocedure)
     <> 'cc9ea6c2d638b040943cc31d8b023382' THEN
    RAISE EXCEPTION 'candy_apply_edition_key_aliases changed since 20261114002600; re-read before replacing';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.candy_apply_edition_key_aliases(p_limit integer default 5000)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  c_candy constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
  v_started timestamptz := clock_timestamp();
  v_wmc int := 0;
  v_sales int := 0;
  v_listings int := 0;
  v_offers int := 0;
  v_left bigint;
begin
  -- holdings: a bounded batch, labels from the canonical edition (identical by construction; set for certainty)
  with batch as (
    select w.id, a.canonical_key
      from public.wallet_moments_cache w
      join public.candy_edition_key_aliases a on a.alias_key = w.edition_key
     where w.collection_id = c_candy
     limit greatest(coalesce(p_limit, 5000), 0)
  )
  update public.wallet_moments_cache w
     set edition_key = b.canonical_key,
         tier        = coalesce(ce.tier::text, w.tier),  -- editions.tier is the tier_type enum; wmc.tier is text
         mint_count  = coalesce(ce.circulation_count, w.mint_count),
         set_name    = coalesce(ce.set_name, w.set_name)
    from batch b
    join public.editions ce on ce.collection_id = c_candy and ce.external_id = b.canonical_key
   where w.id = b.id;
  get diagnostics v_wmc = row_count;

  -- market rows: few, moved whole (the edition_id triggers do the same on every new write)
  with m as (
    select ae.id as alias_id, ce.id as canon_id
      from public.candy_edition_key_aliases a
      join public.editions ae on ae.collection_id = c_candy and ae.external_id = a.alias_key
      join public.editions ce on ce.collection_id = c_candy and ce.external_id = a.canonical_key
  )
  update public.sales s set edition_id = m.canon_id
    from m where s.collection_id = c_candy and s.edition_id = m.alias_id;
  get diagnostics v_sales = row_count;

  with m as (
    select ae.id as alias_id, ce.id as canon_id
      from public.candy_edition_key_aliases a
      join public.editions ae on ae.collection_id = c_candy and ae.external_id = a.alias_key
      join public.editions ce on ce.collection_id = c_candy and ce.external_id = a.canonical_key
  )
  update public.candy_listings l set edition_id = m.canon_id from m where l.edition_id = m.alias_id;
  get diagnostics v_listings = row_count;

  with m as (
    select ae.id as alias_id, ce.id as canon_id
      from public.candy_edition_key_aliases a
      join public.editions ae on ae.collection_id = c_candy and ae.external_id = a.alias_key
      join public.editions ce on ce.collection_id = c_candy and ce.external_id = a.canonical_key
  )
  update public.candy_offers o set edition_id = m.canon_id from m where o.edition_id = m.alias_id;
  get diagnostics v_offers = row_count;

  select count(*) into v_left
    from public.wallet_moments_cache w
    join public.candy_edition_key_aliases a on a.alias_key = w.edition_key
   where w.collection_id = c_candy;

  perform public.log_pipeline_run(
    'candy-edition-key-alias-apply', v_started, v_wmc + v_sales + v_listings + v_offers,
    v_wmc + v_sales + v_listings + v_offers, 0, true, null, 'candy_mlb', null, null,
    jsonb_build_object('wmc_moved', v_wmc, 'sales_moved', v_sales, 'listings_moved', v_listings,
                       'offers_moved', v_offers, 'wmc_left', v_left, 'limit', p_limit));
  return jsonb_build_object('ok', true, 'wmc_moved', v_wmc, 'sales_moved', v_sales, 'listings_moved', v_listings,
                            'offers_moved', v_offers, 'wmc_left', v_left);
end $fn$;
