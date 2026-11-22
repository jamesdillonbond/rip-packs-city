-- Pool model: add a sale-backed gate (>= 50 % of pool dollar value on cards with a 90-day recorded sale); no DELETE in body (2026-11-22).
-- anon-exec: unchanged (refresh_panini_pack_ev_pool) — CREATE OR REPLACE of the fn created this morning with revoke; ACL preserved.
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

  perform public.log_pipeline_run('panini-pack-ev-pool', true,
    jsonb_build_object('packs', v_written, 'modeled', v_modeled, 'upserted', v_written,
                       'ms', round(extract(epoch from clock_timestamp() - v_started) * 1000)));
  return jsonb_build_object('ok', true, 'packs', v_written, 'modeled', v_modeled);
exception when query_canceled or others then
  perform public.log_pipeline_run('panini-pack-ev-pool', false, jsonb_build_object('error', sqlerrm));
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;