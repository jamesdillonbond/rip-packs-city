-- Optimize get_pack_detail_bundle's hero-editions query (the #1 total-time RPC
-- driving the pack-detail-page connection-pool timeouts: 2254 calls, ~1.1s mean,
-- 29s tail). The old query joined `editions` (pk lookup, I/O-bound) AND ran the
-- rep-nft lookup for ALL pool editions (~1.5k) before sorting by FMV and taking
-- top-5 — ~3.9s of a 4.2s worst-case was those wasted per-edition editions reads.
-- New: score FMV per edition in a MATERIALIZED CTE (so the FMV subquery runs once
-- per edition instead of 3x from being inlined into WHERE+ORDER BY), fold
-- total_weight over the same set (weights are non-negative so sum over
-- drop_weight>0 == sum over all → identical hit_probability), then join editions
-- + the rep-nft lookup ONLY for the final 5. Output verified byte-identical to the
-- prior definition across 29 dists spanning all 5 collections + the size spectrum.
-- Warm worst-case ~1.1s → ~27ms. Everything except the hero block is unchanged.
--
-- Revert: restore the prior body (single-pass hero) from migration history.
CREATE OR REPLACE FUNCTION public.get_pack_detail_bundle(p_collection_id uuid, p_dist_id text, p_collection_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
declare
  v_pack_row      jsonb;
  v_dist_fallback jsonb;
  v_corrected_ev  jsonb;
  v_hero          jsonb;
  v_has_pool      boolean;
begin
  select to_jsonb(t) into v_pack_row
  from public.pack_table_rows t
  where t.collection_id = p_collection_id and t.dist_id = p_dist_id
  limit 1;

  select jsonb_build_object('metadata', d.metadata, 'image_url', d.image_url, 'title', d.title)
    into v_dist_fallback
  from public.pack_distributions d
  where d.collection_id = p_collection_id and d.dist_id = p_dist_id
  limit 1;

  -- AllDay corrected EV (odds/median-robust cross-check) — AllDay only.
  if p_collection_slug = 'nfl-all-day' then
    select jsonb_build_object(
             'corrected_gross_ev', v.corrected_gross_ev,
             'corrected_net_ev', v.corrected_net_ev,
             'corrected_value_ratio', v.corrected_value_ratio,
             'ev_method', v.ev_method,
             'has_published_odds', v.has_published_odds,
             'stale_value_share_pct', v.stale_value_share_pct,
             'low_confidence_ev', v.low_confidence_ev,
             'opened_count', v.opened_count,
             'packnft_total', v.packnft_total,
             'opened_pct_of_minted', v.opened_pct_of_minted
           )
      into v_corrected_ev
    from public.v_allday_pack_info v
    where v.dist_id = p_dist_id
    limit 1;
  end if;

  -- Top-5 pool editions by FMV — powers the hero montage + Top-pulls strip.
  -- Optimized (see migration header): score FMV once/edition in a MATERIALIZED
  -- CTE, fold total_weight over the same set, then join editions + the rep-nft
  -- lookup only for the final 5 rows.
  with scored as materialized (
    select pdp.edition_id, pdp.drop_weight,
           (select fs.fmv_usd from public.fmv_snapshots fs
              where fs.edition_id = pdp.edition_id order by fs.computed_at desc limit 1) as fmv_usd
    from public.pack_drop_pool pdp
    where pdp.collection_id = p_collection_id and pdp.dist_id = p_dist_id
      and pdp.drop_weight > 0
  ),
  tw as (
    select nullif(sum(drop_weight), 0) as total_weight from scored
  ),
  top5 as (
    select edition_id, drop_weight, fmv_usd
    from scored
    where fmv_usd is not null and fmv_usd > 0
    order by fmv_usd desc
    limit 5
  )
  select coalesce(jsonb_agg(row_to_json(h)::jsonb order by h.fmv_usd desc), '[]'::jsonb)
    into v_hero
  from (
    select coalesce(e.external_id, e.id::text) as route_slug,
           e.player_name, e.set_name, e.tier::text as tier, e.thumbnail_url,
           (select w.moment_id from public.wallet_moments_cache w
              where w.collection_id = p_collection_id and w.edition_key = e.external_id
                and w.moment_id ~ '^[0-9]+$' limit 1) as rep_nft_id,
           t.fmv_usd::float8 as fmv_usd,
           (t.drop_weight / tw.total_weight)::float8 as hit_probability
    from top5 t
    cross join tw
    join public.editions e on e.id = t.edition_id
  ) h;

  select exists(
    select 1 from public.pack_drop_pool
    where collection_id = p_collection_id and dist_id = p_dist_id and drop_weight > 0
  ) into v_has_pool;

  return jsonb_build_object(
    'pack_row', v_pack_row,
    'dist_fallback', v_dist_fallback,
    'corrected_ev', v_corrected_ev,
    'hero_editions', coalesce(v_hero, '[]'::jsonb),
    'has_pool', coalesce(v_has_pool, false)
  );
end;
$function$;
