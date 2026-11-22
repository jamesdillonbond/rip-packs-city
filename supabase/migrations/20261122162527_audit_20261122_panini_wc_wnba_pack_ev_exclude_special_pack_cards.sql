-- WC Prizm model: exclude special-pack sets (White Sparkle / Animal Print / Floral ship in their own packs), cap card values at live low ask;
-- generalise the pack sim to 1038/1056/1055 with the same rules. See repo migration 20261122170000.
-- anon-exec: unchanged (refresh_panini_pack_ev_sim) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (has_function_privilege anon = false, read 2026-11-22).
create or replace view public.panini_pack_ev_model with (security_invoker = on) as
 WITH ed AS (
         SELECT
                CASE
                    WHEN e.set_name ~~* 'Base Prizms Silver' THEN 'silver'
                    WHEN e.parallel_family = 'fotl_exclusive' THEN 'fotl'
                    WHEN e.parallel_family = 'base' THEN 'base'
                    ELSE 'insert'
                END AS cls,
            COALESCE(e.still_in_packs, 0) AS remain,
            ( SELECT CASE WHEN e.serial_low_ask_usd > 0 THEN LEAST(fs.fmv_usd, e.serial_low_ask_usd) ELSE fs.fmv_usd END
                   FROM panini_fmv_snapshots fs
                  WHERE fs.edition_id = e.id
                  ORDER BY fs.computed_at DESC
                 LIMIT 1) AS fmv
           FROM panini_editions e
          WHERE e.external_id ~~ 'packcard-2332\_%'
            AND e.set_name !~* '(white sparkle|floral|animal print|giraffe|elephant)'
        ), agg AS (
         SELECT ed.cls,
            sum(ed.fmv * ed.remain::numeric) / NULLIF(sum(ed.remain), 0)::numeric AS sw,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY (CASE WHEN ed.remain > 0 THEN ed.fmv ELSE NULL::numeric END)::double precision) AS med
           FROM ed
          WHERE ed.fmv IS NOT NULL
          GROUP BY ed.cls
        ), p AS (
         SELECT max(agg.sw) FILTER (WHERE agg.cls = 'silver') AS silver_sw,
            max(agg.med) FILTER (WHERE agg.cls = 'silver') AS silver_med,
            max(agg.sw) FILTER (WHERE agg.cls = 'base') AS base_sw,
            max(agg.med) FILTER (WHERE agg.cls = 'base') AS base_med,
            max(agg.sw) FILTER (WHERE agg.cls = 'insert') AS insert_sw,
            max(agg.med) FILTER (WHERE agg.cls = 'insert') AS insert_med,
            max(agg.sw) FILTER (WHERE agg.cls = 'fotl') AS fotl_sw,
            max(agg.med) FILTER (WHERE agg.cls = 'fotl') AS fotl_med,
            ( SELECT sum(ed.remain) FROM ed WHERE ed.cls = 'fotl') AS fotl_remain
           FROM agg
        )
 SELECT round(silver_sw) AS silver_ev,
    round(base_sw) AS base_parallel_ev,
    round(insert_sw) AS insert_ev,
    round(fotl_sw) AS fotl_exclusive_ev,
    round(2::numeric * silver_sw + 1.65 * base_sw + 0.35 * insert_sw) AS hobby_actual_ev,
    round(2::double precision * silver_med + 1.65::double precision * base_med + 0.35::double precision * insert_med) AS hobby_typical_ev,
    round(2::numeric * silver_sw + 1.65 * base_sw + 0.35 * insert_sw + fotl_sw) AS fotl_actual_ev,
    round(2::double precision * silver_med + 1.65::double precision * base_med + 0.35::double precision * insert_med + fotl_med) AS fotl_typical_ev,
    'panini-pack-ev-0.6 · REMAINING-BASIS (families weighted by still_in_packs, typical over pullable editions) · each card at its current price capped at its lowest live ask · White Sparkle and Animal Print cards excluded (they ship in their own packs) · Hobby 4 cards = 2 Silver + 1 base parallel + (base parallel or insert 7/20) · FOTL = Hobby + 1 guaranteed exclusive · card counts per Panini pack_label/description, 2026-09-29'::text AS model_note,
    fotl_remain AS fotl_remain_indexed
   FROM p;
alter view public.panini_pack_ev_model set (security_invoker = on);

-- when-others-timeout-blind: intentional — the per-pack handler records and continues over a 3-pack loop; the outer handler catches query_canceled. (Comment added at commit; prod's stored statement is identical but for this line.)
create or replace function public.refresh_panini_pack_ev_sim(p_sims integer default 20000)
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
 set statement_timeout to '100s'
as $function$
declare
  c        record;
  v_cost   numeric;
  v_packs  integer;
  s_lo float8[]; s_v numeric[]; s_t float8;
  b_lo float8[]; b_v numeric[]; b_t float8;
  i_lo float8[]; i_v numeric[]; i_t float8;
  f_lo float8[]; f_v numeric[]; f_t float8;
  v_n integer; v_mean numeric; v_median numeric; v_p numeric;
  v_out    jsonb := '[]'::jsonb;
  v_ok     integer := 0;
begin
  for c in
    select * from (values ('1038', 2332, 0.35::float8, false),
                          ('1056', 2420, 0.25::float8, false),
                          ('1055', 2420, 0.25::float8, true)) v(pack_id, set_id, insert_p, has_fotl)
  loop
    begin
      select pack_cost_usd, packs_remaining into v_cost, v_packs from panini_pack_ev_board where id = c.pack_id;

      create temp table if not exists _sim_ed (cls text, w float8, v numeric) on commit drop;
      truncate _sim_ed;
      insert into _sim_ed
      select case when e.set_name ~~* 'Base Prizms Silver' then 'silver'
                  when e.parallel_family = 'fotl_exclusive'
                    or (c.set_id = 2420 and e.set_name ~* '^Base Prizms (Cherry Blossom|Plum Blossom|Lotus Flower)$') then 'fotl'
                  when e.parallel_family = 'base' then 'base'
                  else 'insert' end,
             e.still_in_packs,
             (select case when e.serial_low_ask_usd > 0 then least(fs.fmv_usd, e.serial_low_ask_usd) else fs.fmv_usd end
                from panini_fmv_snapshots fs where fs.edition_id = e.id order by fs.computed_at desc limit 1)
        from panini_editions e
       where e.product_set_id = c.set_id and e.still_in_packs > 0
         and e.set_name !~* '(white sparkle|floral|animal print|giraffe|elephant)';

      if c.has_fotl and coalesce((select sum(w) from _sim_ed where cls = 'fotl'), 0) < 0.9 * coalesce(v_packs, 0) then
        raise exception 'FOTL exclusive slot under-indexed (% of % packs)', (select sum(w) from _sim_ed where cls = 'fotl'), v_packs;
      end if;

      select array_agg(lo order by rn), array_agg(v order by rn), max(lo + w) into s_lo, s_v, s_t from (select v, w, row_number() over (order by v, w) rn, coalesce(sum(w) over (order by v, w rows between unbounded preceding and 1 preceding), 0) lo from _sim_ed where cls = 'silver' and v is not null) x;
      select array_agg(lo order by rn), array_agg(v order by rn), max(lo + w) into b_lo, b_v, b_t from (select v, w, row_number() over (order by v, w) rn, coalesce(sum(w) over (order by v, w rows between unbounded preceding and 1 preceding), 0) lo from _sim_ed where cls = 'base' and v is not null) x;
      select array_agg(lo order by rn), array_agg(v order by rn), max(lo + w) into i_lo, i_v, i_t from (select v, w, row_number() over (order by v, w) rn, coalesce(sum(w) over (order by v, w rows between unbounded preceding and 1 preceding), 0) lo from _sim_ed where cls = 'insert' and v is not null) x;
      select array_agg(lo order by rn), array_agg(v order by rn), max(lo + w) into f_lo, f_v, f_t from (select v, w, row_number() over (order by v, w) rn, coalesce(sum(w) over (order by v, w rows between unbounded preceding and 1 preceding), 0) lo from _sim_ed where cls = 'fotl' and v is not null) x;

      if s_t is null or b_t is null or i_t is null or (c.has_fotl and f_t is null) then
        raise exception 'a card family has no priced, in-pack edition';
      end if;

      with packs as (
        select s_v[width_bucket(random() * s_t, s_lo)]
             + s_v[width_bucket(random() * s_t, s_lo)]
             + b_v[width_bucket(random() * b_t, b_lo)]
             + case when random() < c.insert_p then i_v[width_bucket(random() * i_t, i_lo)]
                    else b_v[width_bucket(random() * b_t, b_lo)] end
             + case when c.has_fotl then f_v[width_bucket(random() * f_t, f_lo)] else 0 end as val
          from generate_series(1, greatest(p_sims, 1000))
      )
      select count(*), avg(val), percentile_cont(0.5) within group (order by val),
             case when v_cost > 0 then avg((val >= v_cost)::int) end
        into v_n, v_mean, v_median, v_p
        from packs;

      insert into panini_pack_ev_sim as t (pack_id, sims, mean_pull_usd, median_pull_usd, p_beat_cost, cost_usd, computed_at, ok, error)
      values (c.pack_id, v_n, round(v_mean, 2), round(v_median, 2), round(v_p, 4), v_cost, now(), true, null)
      on conflict (pack_id) do update
        set sims = excluded.sims, mean_pull_usd = excluded.mean_pull_usd, median_pull_usd = excluded.median_pull_usd,
            p_beat_cost = excluded.p_beat_cost, cost_usd = excluded.cost_usd, computed_at = excluded.computed_at,
            ok = true, error = null;
      v_ok := v_ok + 1;
      v_out := v_out || jsonb_build_object('pack', c.pack_id, 'ok', true, 'mean', round(v_mean, 2), 'median', round(v_median, 2), 'p_beat_cost', round(v_p, 4), 'cost', v_cost);
    exception when others then   -- when-others-timeout-blind: intentional (per-pack record-and-continue; outer handler catches query_canceled)
      insert into panini_pack_ev_sim as t (pack_id, sims, computed_at, ok, error)
      values (c.pack_id, 0, now(), false, sqlerrm)
      on conflict (pack_id) do update
        set sims = 0, mean_pull_usd = null, median_pull_usd = null, p_beat_cost = null, cost_usd = null,
            computed_at = now(), ok = false, error = excluded.error;
      v_out := v_out || jsonb_build_object('pack', c.pack_id, 'ok', false, 'error', sqlerrm);
    end;
  end loop;

  perform public.log_pipeline_run('panini-pack-ev-sim', v_ok > 0,
    jsonb_build_object('packs', v_out, 'rows_written', 3, 'upserted', 3));
  return jsonb_build_object('ok', v_ok > 0, 'packs', v_out);
exception when query_canceled or others then
  perform public.log_pipeline_run('panini-pack-ev-sim', false, jsonb_build_object('error', sqlerrm));
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;