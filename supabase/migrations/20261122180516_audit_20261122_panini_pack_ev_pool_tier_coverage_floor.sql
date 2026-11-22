-- audit_20261122_panini_pack_ev_pool_tier_coverage_floor
--
-- anon-exec: revoked (panini_pack_ev_pool_tier_gate) — new fn; REVOKE FROM PUBLIC, anon, authenticated below; postgres + service_role only.
-- anon-exec: unchanged (refresh_panini_pack_ev_pool) — CREATE OR REPLACE of an existing fn; ACL preserved (anon false, read 11-22).
--
-- 2026-11-22 (Claude Code cloud; Trevor: "Approve and proceed", Panini pack-EV strategy P0.2).
--
-- WHY. The pool model prices a pack from the cards we have CATALOGUED still in it — and the catalogue is
-- listing-driven, so a rare tier whose cards are seldom listed is mostly absent. Its value is then simply
-- missing from the EV, which is biased LOW. Measured 11-22 from Panini's own rarity_distribution
-- (unique_pskus per tier) against panini_editions:
--   WC Stickers (1058)  Epic 1.8 % of cards, ~37 % of est. value, 406 of 1,920 catalogued (21 %)
--   Moonbirds   (1049)  Legendary 0.31 % of cards, ~13 % of est. value, 5 of 24 catalogued (21 %) — and the
--                       5 we hold are already pulled, so NO Legendary sits in the pool.
-- Both published EVs ($6.75, $57.22) are floors, not estimates.
--
-- WHAT CHANGES.
--   panini_pack_ev_pool  + ev_is_floor boolean, + tier_coverage jsonb (per tier: % of cards, distinct cards,
--                        catalogued, coverage, est. value share, gated, short).
--   panini_pack_ev_pool_tier_gate(text[])  NEW. A tier is GATED when it is >= 1 % of cards or >= 10 % of the
--                        estimated value (pct x mean catalogued price, capped at the live ask; unknown counts);
--                        it is SHORT when < 50 % of its distinct cards are catalogued. Any short gated tier, or
--                        no rarity breakdown at all, => ev_is_floor and a model_note naming the tier.
--   refresh_panini_pack_ev_pool  calls the gate after its loop; logs 'floored'. Body otherwise identical to
--                        20261122160943 (prosrc md5 4f6d87c49e282734c86394409840cd3c, premise below).
--   panini_pack_ev_board + ev_is_floor (appended LAST; every other column identical to 20261122170146,
--                        viewdef md5 13ccf7bcf3210a1e02aadad3a053e173, premise below). True only for a pool-priced
--                        pack, and NULL-from-the-pool reads as a floor — an unchecked EV is never claimed as an estimate.
-- The app labels such an EV "at least $X" (app/api/panini-pack-market, PaniniPackMarket, concierge).
--
-- Revert: re-apply 20261122170146 (view, drops the column) and 20261122160943 (function); then
--   drop function public.panini_pack_ev_pool_tier_gate(text[]);
--   alter table public.panini_pack_ev_pool drop column ev_is_floor, drop column tier_coverage;

DO $premise$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'refresh_panini_pack_ev_pool') <> '4f6d87c49e282734c86394409840cd3c' THEN
    RAISE EXCEPTION 'premise: refresh_panini_pack_ev_pool changed since read; re-read before replacing';
  END IF;
  IF md5(pg_get_viewdef('public.panini_pack_ev_board'::regclass)) <> '13ccf7bcf3210a1e02aadad3a053e173' THEN
    RAISE EXCEPTION 'premise: panini_pack_ev_board changed since read; re-read before replacing';
  END IF;
END
$premise$;

alter table public.panini_pack_ev_pool
  add column if not exists ev_is_floor boolean,
  add column if not exists tier_coverage jsonb;

-- when-others-timeout-blind: intentional (no handler here; the only caller, refresh_panini_pack_ev_pool, records any failure)
create function public.panini_pack_ev_pool_tier_gate(p_pack_ids text[])
 returns integer
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_n integer;
begin
  with pk as (
    select t.pack_id, t.product_set_id, s.raw->'pack_config_info'->'rarity_distribution' as rd
      from panini_pack_ev_pool t join panini_pack_state s on s.id = t.pack_id
     where t.pack_id = any(p_pack_ids)
  ), tiers as (
    select pk.pack_id, pk.product_set_id, d->>'rarity' as tier,
           nullif(d->>'percentage', '')::numeric as pct, nullif(d->>'unique_pskus', '')::int as total
      from pk cross join lateral jsonb_array_elements(case when jsonb_typeof(pk.rd) = 'array' then pk.rd else '[]'::jsonb end) d
  ), cat as (
    -- catalogued = every edition we hold for the tier (pulled or not); its mean price is the
    -- latest FMV capped at its lowest live ask, as the pool prices cards.
    select tr.pack_id, tr.tier, tr.pct, tr.total, count(e.id) as catalogued,
           avg(case when e.serial_low_ask_usd > 0 and f.fmv_usd > e.serial_low_ask_usd then e.serial_low_ask_usd else f.fmv_usd end) as mean_usd
      from tiers tr
      left join panini_editions e on e.product_set_id = tr.product_set_id and e.rarity_label = tr.tier
      left join lateral (select fs.fmv_usd from panini_fmv_snapshots fs
                          where fs.edition_id = e.id order by fs.computed_at desc limit 1) f on true
     group by tr.pack_id, tr.tier, tr.pct, tr.total
  ), scored as (
    select c.*,
           c.catalogued::numeric / nullif(c.total, 0) as cov,
           c.pct * c.mean_usd / nullif(sum(c.pct * coalesce(c.mean_usd, 0)) over (partition by c.pack_id), 0) as vs
      from cat c
  ), judged as (
    -- a tier counts when it is >= 1 % of cards or >= 10 % of the estimated value (unknown value counts);
    -- it is SHORT when under half of its distinct cards are catalogued (unknown size counts as short).
    select s.*,
           (coalesce(s.pct, 0) >= 1 or s.vs is null or s.vs >= 0.10) as gated,
           (coalesce(s.pct, 0) >= 1 or s.vs is null or s.vs >= 0.10) and (s.cov is null or s.cov < 0.5) as short
      from scored s
  ), per as (
    select j.pack_id,
           jsonb_agg(jsonb_build_object('tier', j.tier, 'pct_of_cards', j.pct, 'distinct_cards', j.total,
                     'catalogued', j.catalogued, 'coverage', round(j.cov, 3), 'est_value_share', round(j.vs, 3),
                     'gated', j.gated, 'short', j.short) order by j.pct desc nulls last) as cov,
           bool_or(j.short) as any_short,
           string_agg(case when j.short then
                        j.tier || ' cards: ' || j.catalogued || ' of ' || coalesce(j.total::text, '?') || ' catalogued, ~'
                        || coalesce(round(j.vs * 100)::text || '% of the value', 'unknown share of the value')
                      end, '; ' order by j.pct desc nulls last) as why
      from judged j group by j.pack_id
  ), res as (
    select pk.pack_id, per.cov, coalesce(per.any_short, true) as is_floor,
           coalesce(per.why, 'Panini publishes no rarity breakdown for this pack, so tier coverage cannot be checked') as why
      from pk left join per on per.pack_id = pk.pack_id
  )
  update panini_pack_ev_pool t
     set tier_coverage = res.cov,
         ev_is_floor   = case when t.modeled then res.is_floor end,
         model_note    = case when t.modeled and res.is_floor and t.model_note not like '%EV is a floor%'
                              then t.model_note || ' · EV is a floor (at least): under-catalogued rare tiers are missing from the pool · ' || res.why
                              else t.model_note end
    from res
   where t.pack_id = res.pack_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke execute on function public.panini_pack_ev_pool_tier_gate(text[]) from public, anon, authenticated;
grant execute on function public.panini_pack_ev_pool_tier_gate(text[]) to postgres, service_role;

-- when-others-timeout-blind: intentional (unchanged handler shape; it already names query_canceled)
create or replace function public.refresh_panini_pack_ev_pool(p_sims integer default 5000)
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
 set statement_timeout to '110s'
as $function$
declare
  v_started  timestamptz := clock_timestamp();
  r          record;
  v_lo       float8[];
  v_v        numeric[];
  v_tot      float8;
  v_mean     numeric;
  v_median   numeric;
  v_p        numeric;
  v_n        integer;
  v_written  integer := 0;
  v_modeled  integer := 0;
  v_ids      text[] := '{}';
  v_floored  integer;
begin
  for r in
    with live as (
      select s.product_set_id, count(*) as n_rows, max(s.id) as pack_id
        from panini_pack_state s
       where coalesce(s.packs_remaining, 0) > 0 and s.product_set_id is not null
       group by s.product_set_id
    ), one as (
      select s.id as pack_id, s.product_set_id, s.cards_per_pack, s.packs_remaining,
             coalesce(s.floor_usd, s.avg_sale_usd) as cost
        from live l join panini_pack_state s on s.id = l.pack_id
       where l.n_rows = 1
         and s.product_set_id not in (2332, 2420)
         and coalesce(s.cards_per_pack, 0) > 0
    ), sup as (
      select o.*, count(e.*) as eds, coalesce(sum(e.still_in_packs), 0) as still
        from one o left join panini_editions e on e.product_set_id = o.product_set_id and e.still_in_packs > 0
       group by o.pack_id, o.product_set_id, o.cards_per_pack, o.packs_remaining, o.cost
    )
    select sup.*, round(sup.still::numeric / (sup.packs_remaining * sup.cards_per_pack), 3) as cover
      from sup
  loop
    v_ids := v_ids || r.pack_id;
    if r.cover between 0.85 and 1.15 and r.eds >= 20 then
      create temp table if not exists _pool (w float8, fmv numeric, conf text, ask numeric, sold90 boolean) on commit drop;
      truncate _pool;
      insert into _pool
      select e.still_in_packs, f.fmv_usd, f.confidence::text, e.serial_low_ask_usd,
             exists (select 1 from panini_sales ps where ps.edition_external_id = e.external_id
                       and ps.sold_at >= now() - interval '90 days' and ps.amount_usd > 0)
        from panini_editions e
        left join lateral (select fs.fmv_usd, fs.confidence from panini_fmv_snapshots fs
                            where fs.edition_id = e.id order by fs.computed_at desc limit 1) f on true
       where e.product_set_id = r.product_set_id and e.still_in_packs > 0;
      update _pool set fmv = ask where ask > 0 and fmv > ask;

      select sum(w) filter (where fmv is not null) / sum(w),
             sum(w * fmv::float8) filter (where conf in ('HIGH','MEDIUM')) / nullif(sum(w * fmv::float8), 0)
        into v_mean, v_p
        from _pool;
      select sum(w * fmv::float8) filter (where sold90) / nullif(sum(w * fmv::float8), 0) into v_median from _pool;

      if v_mean >= 0.95 and v_p >= 0.50 and v_median >= 0.50 then
        select array_agg(lo order by rn), array_agg(fmv order by rn), max(lo + w)
          into v_lo, v_v, v_tot
          from (select fmv, w, row_number() over (order by fmv, w) rn,
                       coalesce(sum(w) over (order by fmv, w rows between unbounded preceding and 1 preceding), 0) lo
                  from _pool where fmv is not null) x;

        with packs as (
          select (select sum(v_v[width_bucket(random() * v_tot, v_lo)])
                    from generate_series(1, r.cards_per_pack) d
                   where g.i > 0) as val
            from generate_series(1, greatest(p_sims, 1000)) g(i)
        )
        select count(*), percentile_cont(0.5) within group (order by val),
               case when r.cost > 0 then avg((val >= r.cost)::int) end
          into v_n, v_median, v_p
          from packs;

        select r.cards_per_pack * sum(w::numeric * fmv) / sum(w::numeric) into v_mean from _pool where fmv is not null;

        insert into panini_pack_ev_pool as t (pack_id, product_set_id, cards_per_pack, packs_remaining, editions_in_pool,
               cards_in_pool, cover_ratio, priced_share, hm_share, modeled, actual_ev_usd, typical_ev_usd, p_beat_cost,
               cost_usd, sims, model_note, computed_at)
        select r.pack_id, r.product_set_id, r.cards_per_pack, r.packs_remaining, r.eds, r.still, r.cover,
               round(sum(w) filter (where fmv is not null)::numeric / sum(w)::numeric, 3),
               round((sum(w * fmv::float8) filter (where conf in ('HIGH','MEDIUM')) / nullif(sum(w * fmv::float8), 0))::numeric, 3),
               true, round(v_mean, 2), round(v_median, 2), round(v_p, 4), r.cost, v_n,
               'modeled from the cards still in these packs · ' || r.still || ' sealed cards across ' || r.eds
                 || ' editions, each at its current price capped at its lowest live ask, weighted by how many copies are still in packs · typical pull is a simulated median pack · unpriced cards excluded',
               now()
          from _pool
        on conflict (pack_id) do update set product_set_id = excluded.product_set_id, cards_per_pack = excluded.cards_per_pack,
               packs_remaining = excluded.packs_remaining, editions_in_pool = excluded.editions_in_pool,
               cards_in_pool = excluded.cards_in_pool, cover_ratio = excluded.cover_ratio, priced_share = excluded.priced_share,
               hm_share = excluded.hm_share, modeled = true, actual_ev_usd = excluded.actual_ev_usd,
               typical_ev_usd = excluded.typical_ev_usd, p_beat_cost = excluded.p_beat_cost, cost_usd = excluded.cost_usd,
               sims = excluded.sims, model_note = excluded.model_note, computed_at = excluded.computed_at;

        insert into panini_pack_ev_sim as t (pack_id, sims, mean_pull_usd, median_pull_usd, p_beat_cost, cost_usd, computed_at, ok, error)
        values (r.pack_id, v_n, round(v_mean, 2), round(v_median, 2), round(v_p, 4), r.cost, now(), true, null)
        on conflict (pack_id) do update set sims = excluded.sims, mean_pull_usd = excluded.mean_pull_usd,
               median_pull_usd = excluded.median_pull_usd, p_beat_cost = excluded.p_beat_cost, cost_usd = excluded.cost_usd,
               computed_at = excluded.computed_at, ok = true, error = null;
        v_modeled := v_modeled + 1;
        v_written := v_written + 1;
        continue;
      end if;
    end if;

    insert into panini_pack_ev_pool as t (pack_id, product_set_id, cards_per_pack, packs_remaining, editions_in_pool,
           cards_in_pool, cover_ratio, modeled, model_note, computed_at)
    values (r.pack_id, r.product_set_id, r.cards_per_pack, r.packs_remaining, r.eds, r.still, r.cover, false,
            case when r.eds < 20 then 'pool not modeled · only ' || r.eds || ' editions catalogued'
                 when r.cover is null or r.cover < 0.85 or r.cover > 1.15
                 then 'pool not modeled · our card catalogue covers ' || coalesce(r.cover::text, '0') || '× the sealed supply'
                 else 'pool not modeled · too little of the remaining pool value is priced with confidence or backed by recorded sales' end,
            now())
    on conflict (pack_id) do update set product_set_id = excluded.product_set_id, cards_per_pack = excluded.cards_per_pack,
           packs_remaining = excluded.packs_remaining, editions_in_pool = excluded.editions_in_pool,
           cards_in_pool = excluded.cards_in_pool, cover_ratio = excluded.cover_ratio, modeled = false,
           priced_share = null, hm_share = null,
           actual_ev_usd = null, typical_ev_usd = null, p_beat_cost = null, cost_usd = null, sims = null,
           model_note = excluded.model_note, computed_at = excluded.computed_at;
    v_written := v_written + 1;
  end loop;

  -- 2026-11-22 tier-coverage gate (strategy P0.2): an under-catalogued rarity tier makes the pool EV a floor.
  v_floored := public.panini_pack_ev_pool_tier_gate(v_ids);

  perform public.log_pipeline_run('panini-pack-ev-pool', true,
    jsonb_build_object('packs', v_written, 'modeled', v_modeled, 'upserted', v_written, 'floored', v_floored,
                       'ms', round(extract(epoch from clock_timestamp() - v_started) * 1000)));
  return jsonb_build_object('ok', true, 'packs', v_written, 'modeled', v_modeled);
exception when query_canceled or others then
  perform public.log_pipeline_run('panini-pack-ev-pool', false, jsonb_build_object('error', sqlerrm));
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

create or replace view public.panini_pack_ev_board with (security_invoker = on) as
 SELECT p.id,
    p.collection_id,
    p.pack_type,
    COALESCE(p.floor_usd, p.avg_sale_usd) AS pack_cost_usd,
    p.floor_usd,
    p.avg_sale_usd,
    p.recent_sale_usd,
    p.cards_per_pack,
    p.packs_total,
    p.packs_remaining,
        CASE
            WHEN COALESCE(p.packs_total, 0) > 0 THEN round((p.packs_total - COALESCE(p.packs_remaining, p.packs_total))::numeric / p.packs_total::numeric * 100::numeric, 1)
            ELSE NULL::numeric
        END AS packs_ripped_pct,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 THEN
            CASE
                WHEN p.pack_type = 'fotl'::text THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_actual_ev
            WHEN p.model_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND s.hobby_modeled THEN s.hobby_actual_ev
            WHEN p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval) THEN g.actual_ev_usd
            WHEN up.use_pool THEN pl.actual_ev_usd
            ELSE NULL::numeric
        END AS actual_ev_usd,
        CASE
            WHEN fw.withheld THEN NULL::double precision
            WHEN p.model_set_id = 2332 THEN
            CASE
                WHEN p.pack_type = 'fotl'::text THEN m.fotl_typical_ev
                ELSE m.hobby_typical_ev
            END
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_typical_ev::double precision
            WHEN p.model_set_id = 2420 AND p.pack_type IS DISTINCT FROM 'fotl'::text AND s.hobby_modeled THEN s.hobby_typical_ev::double precision
            WHEN p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval) THEN g.typical_ev_usd::double precision
            WHEN up.use_pool THEN pl.typical_ev_usd::double precision
            ELSE NULL::double precision
        END AS typical_ev_usd,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 THEN m.silver_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.silver_ev
            ELSE NULL::numeric
        END AS silver_ev,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 THEN m.base_parallel_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.base_parallel_ev
            ELSE NULL::numeric
        END AS base_parallel_ev,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 THEN m.insert_ev
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.insert_ev
            ELSE NULL::numeric
        END AS insert_ev,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 AND p.pack_type = 'fotl'::text THEN m.fotl_exclusive_ev
            WHEN p.model_set_id = 2420 AND p.pack_type = 'fotl'::text AND s.fotl_modeled THEN s.fotl_exclusive_ev
            ELSE NULL::numeric
        END AS fotl_exclusive_ev,
        CASE
            WHEN fw.withheld THEN ((('not modeled · only '::text || COALESCE(round(fi.fotl_indexed), 0::numeric)) || ' of the '::text) || p.packs_remaining) || ' FOTL-exclusive cards still in these packs are indexed — Panini shows a card only once it has been listed for sale, so the exclusive slot would be priced from an unrepresentative part of its supply; EV is withheld, not zero'::text
            WHEN p.model_set_id = 2332 THEN m.model_note
            WHEN p.model_set_id = 2420 AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN s.model_note
            WHEN p.model_set_id = 2420 THEN 'not modeled yet · the sales model for this product needs >=10 sales in every card family of this pack and a fit under 6 hours old; EV is withheld, not zero'::text
            WHEN up.use_pool THEN pl.model_note
            WHEN g.model_note IS NOT NULL AND g.computed_at <= (now() - '06:00:00'::interval) THEN 'not modeled · the guaranteed-contents model has not refreshed in 6 hours; EV is withheld, not zero'::text
            WHEN g.model_note IS NOT NULL THEN g.model_note
            WHEN p.product_set_id = ANY (ARRAY[2332, 2420]) THEN 'not modeled · the EV model covers this product''s standard Hobby and FOTL packs only; this pack''s contents and odds differ; EV is withheld, not zero'::text
            ELSE 'not modeled · no pack-EV model exists for this product yet (card prices for it are not collected); EV is withheld, not zero'::text
        END AS model_note,
        CASE
            WHEN fw.withheld THEN NULL::numeric
            WHEN p.model_set_id = 2332 AND COALESCE(p.floor_usd, p.avg_sale_usd) > 0::numeric THEN round(
            CASE
                WHEN p.pack_type = 'fotl'::text THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd))
            WHEN p.model_set_id = 2420 AND COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd) > 0::numeric AND
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END THEN round(
            CASE
                WHEN p.pack_type = 'fotl'::text THEN s.fotl_actual_ev
                ELSE s.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd))
            WHEN p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval) AND COALESCE(p.floor_usd, p.avg_sale_usd) > 0::numeric THEN round(g.actual_ev_usd - COALESCE(p.floor_usd, p.avg_sale_usd))
            WHEN up.use_pool AND COALESCE(p.floor_usd, p.avg_sale_usd) > 0::numeric THEN round(pl.actual_ev_usd - COALESCE(p.floor_usd, p.avg_sale_usd))
            ELSE NULL::numeric
        END AS net_rip_edge_usd,
    p.updated_at,
    p.product_name,
    p.sport,
    p.product_set_id,
    NOT fw.withheld AND ((p.model_set_id = 2332) IS TRUE OR p.model_set_id = 2420 AND
        CASE
            WHEN p.pack_type = 'fotl'::text THEN s.fotl_modeled
            ELSE s.hobby_modeled
        END IS TRUE OR p.model_set_id IS NULL AND g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval) OR up.use_pool) AS ev_modeled,
        CASE
            WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) AND (p.model_set_id IS NOT NULL OR up.use_pool) THEN ps.median_pull_usd
            ELSE NULL::numeric
        END AS sim_median_pull_usd,
        CASE
            WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) AND (p.model_set_id IS NOT NULL OR up.use_pool) THEN ps.p_beat_cost
            ELSE NULL::numeric
        END AS sim_p_beat_cost,
        CASE
            WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) AND (p.model_set_id IS NOT NULL OR up.use_pool) THEN ps.cost_usd
            ELSE NULL::numeric
        END AS sim_cost_usd,
        CASE
            WHEN NOT fw.withheld AND ps.ok AND ps.computed_at > (now() - '03:00:00'::interval) AND (p.model_set_id IS NOT NULL OR up.use_pool) THEN ps.computed_at
            ELSE NULL::timestamp with time zone
        END AS sim_computed_at,
    up.use_pool AND COALESCE(pl.ev_is_floor, true) AS ev_is_floor
   FROM ( SELECT ps_1.id,
            ps_1.collection_id,
            ps_1.pack_type,
            ps_1.price_usd,
            ps_1.cards_per_pack,
            ps_1.packs_total,
            ps_1.packs_remaining,
            ps_1.gross_ev_usd,
            ps_1.net_ev_usd,
            ps_1.updated_at,
            ps_1.floor_usd,
            ps_1.avg_sale_usd,
            ps_1.recent_sale_usd,
            ps_1.top_sale_usd,
            ps_1.raw,
            ps_1.product_name,
            ps_1.sport,
            ps_1.product_set_id,
            ps_1.page_url,
                CASE
                    WHEN ps_1.product_set_id = 2332 AND (ps_1.id = ANY (ARRAY['1038'::text, '1039'::text])) THEN 2332
                    WHEN ps_1.product_set_id = 2420 AND (ps_1.id = ANY (ARRAY['1055'::text, '1056'::text])) THEN 2420
                    ELSE NULL::integer
                END AS model_set_id
           FROM panini_pack_state ps_1) p
     CROSS JOIN panini_pack_ev_model m
     CROSS JOIN LATERAL ( SELECT CASE WHEN p.model_set_id = 2332 THEN m.fotl_remain_indexed::numeric
                                      WHEN p.model_set_id = 2420 THEN (SELECT f.remain::numeric FROM panini_pack_ev_sales_families f WHERE f.product_set_id = 2420 AND f.fam = 'fotl')
                                 END AS fotl_indexed) fi
     CROSS JOIN LATERAL ( SELECT p.model_set_id IS NOT NULL AND p.pack_type = 'fotl'::text AND NOT COALESCE(fi.fotl_indexed >= (0.9 * p.packs_remaining::numeric), false) AS withheld) fw
     LEFT JOIN panini_pack_ev_model_wnba_2026_sales s ON s.product_set_id = p.model_set_id
     LEFT JOIN mv_panini_pack_ev_guaranteed g ON g.pack_id = p.id AND p.model_set_id IS NULL
     LEFT JOIN panini_pack_ev_pool pl ON pl.pack_id = p.id AND p.model_set_id IS NULL
     CROSS JOIN LATERAL ( SELECT p.model_set_id IS NULL
                AND NOT (g.ev_modeled IS TRUE AND g.computed_at > (now() - '06:00:00'::interval))
                AND COALESCE(pl.modeled, false)
                AND pl.computed_at > (now() - '06:00:00'::interval) AS use_pool) up
     LEFT JOIN panini_pack_ev_sim ps ON ps.pack_id = p.id;
alter view public.panini_pack_ev_board set (security_invoker = on);
