-- audit_20261122_panini_pack_ev_tier_shadow
--
-- anon-exec: revoked (refresh_panini_pack_ev_tier_shadow) — new fn; REVOKE FROM PUBLIC, anon, authenticated below; postgres + service_role only.
--
-- 2026-11-22 (Claude Code cloud; Trevor: "Work through all you can for p1 and p2" — Panini pack-EV strategy P1.4/P1.5/P1.6/P2.8).
--
-- WHAT. A SHADOW tier-composition pack-EV model. Nothing user-facing reads it; it exists to be validated
-- (against the pull ledger, panini_edition_supply_obs, once ~2 weeks of pulls exist) before it may replace
-- the WC product model, the WNBA sales model or the pool model.
--
-- MODEL (per product with a live pack carrying Panini's rarity_distribution — ~40 packs across 2021-2026):
--   price      latest panini_fmv_snapshots FMV capped at the edition's lowest live ask (as the pool model).
--   player     rank from an additive log fit  log(price) = player + parallel  (20 ALS rounds), cut in deciles;
--              a player with no priced card sits in decile 1.
--   cell       an uncatalogued (player, parallel) card is priced at the catalogued MEAN price of that parallel in
--              that player's decile (then +-1 decile, then the parallel's mean) — it never extrapolates past an
--              observed price. Measured 11-22 (5-fold holdout, pooled pred/obs): WC Stickers Silver 1.03, Blue 1.03,
--              Red 0.79, Black 0.86, Gold 0.67, Green 0.58; Moonbirds every parallel 0.94-1.15. A per-parallel
--              slope variant (log price = b_q + k_q x player) was tried and REJECTED: pooled 2.3-5.8x on rare tiers.
--   tier       E[value | tier] = (catalogued cells at observed-or-predicted price, weighted by mint cap)
--              + (Panini's unique_pskus - catalogued) missing cells at the mean predicted candidate price.
--   ev_design_usd     cards/pack x sum_tier pct x E[value|tier] / sum pct — the pack AS DESIGNED (minted mix).
--   ev_remaining_usd  only when the product has ONE live pack: the remaining pool (catalogued still_in_packs at
--              their prices) + the uncatalogued sealed cards (packs_remaining x cards - catalogued still) priced
--              at their tiers' predicted means, allocated across tiers by missing cells x mint cap. This is what the
--              cover constraint allows: Moonbirds has ~3 uncatalogued sealed cards, so its floor is tight.
--   validation  per parallel: n and pooled 5-fold holdout pred/obs. gate_ok = every parallel of a >= 90 %-catalogued
--              tier within +-10 %, and every other parallel with >= 30 holdout cards within 0.67-1.5.
--
-- Runs hourly at :49 (a measured 3-job minute), stalest product first, stops starting new products after 80 s
-- (pg_cron's global 120 s cap). Logs 'panini-pack-ev-tier-shadow' with products done / errors.
--
-- REVERT: select cron.unschedule('panini-pack-ev-tier-shadow');
--         drop function public.refresh_panini_pack_ev_tier_shadow(); drop table public.panini_pack_ev_tier_shadow;

create table if not exists public.panini_pack_ev_tier_shadow (
  pack_id            text primary key,
  product_set_id     integer not null,
  cards_per_pack     integer,
  packs_remaining    integer,
  ev_design_usd      numeric,
  ev_catalogued_usd  numeric,
  ev_remaining_usd   numeric,
  published_ev_usd   numeric,
  published_is_floor boolean,
  tiers              jsonb,
  validation         jsonb,
  gate_ok            boolean,
  players            integer,
  priced_editions    integer,
  model_note         text,
  computed_at        timestamptz not null default now()
);
alter table public.panini_pack_ev_tier_shadow enable row level security;
revoke all on public.panini_pack_ev_tier_shadow from public, anon, authenticated;
grant select on public.panini_pack_ev_tier_shadow to service_role;

-- when-others-timeout-blind: intentional (the per-product handler swallows-and-continues, so it must stay bare; the outer handler names query_canceled)
create or replace function public.refresh_panini_pack_ev_tier_shadow()
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_started timestamptz := clock_timestamp();
  v_ps      integer;
  f         integer;
  i         integer;
  v_done    integer := 0;
  v_packs   integer := 0;
  v_errors  jsonb := '[]'::jsonb;
  v_val     jsonb;
  v_gate    boolean;
  v_n       integer;
  v_live    integer;
  v_players integer;
  v_priced  integer;
begin
  for v_ps in
    select x.product_set_id
      from (select s.product_set_id, min(sh.computed_at) as last
              from panini_pack_state s
              left join panini_pack_ev_tier_shadow sh on sh.pack_id = s.id
             where coalesce(s.packs_remaining, 0) > 0 and s.product_set_id is not null
               and jsonb_typeof(s.raw->'pack_config_info'->'rarity_distribution') = 'array'
             group by s.product_set_id) x
     order by x.last nulls first, x.product_set_id
  loop
    exit when clock_timestamp() - v_started > interval '80 seconds';
    begin
      drop table if exists _tc; drop table if exists _tu; drop table if exists _ty0; drop table if exists _tres;
      create temp table _tc as
        select e.id, e.player_name as p, e.parallel as q, e.rarity_label as tier, coalesce(e.mint_cap, 0) as mc,
               coalesce(e.still_in_packs, 0) as still,
               case when e.serial_low_ask_usd > 0 and fs.fmv_usd > e.serial_low_ask_usd then e.serial_low_ask_usd else fs.fmv_usd end::float8 as price
          from panini_editions e
          left join lateral (select x.fmv_usd from panini_fmv_snapshots x where x.edition_id = e.id order by x.computed_at desc limit 1) fs on true
         where e.product_set_id = v_ps and e.player_name is not null and e.parallel is not null;
      create temp table _tu as select distinct p from _tc;
      create temp table _ty0 as select p, q, ln(price) as y, price, abs(hashtext(id)) % 5 as fold from _tc where price > 0;
      create temp table _tres (q text, fold int, pred float8, obs float8, n int);
      select count(*) into v_players from _tu;
      select count(*) into v_priced from _ty0;

      foreach f in array array[0, 1, 2, 3, 4, -1] loop
        drop table if exists _ty; drop table if exists _ta; drop table if exists _tb; drop table if exists _td; drop table if exists _tcell;
        create temp table _ty as select p, q, y, price, (fold = f) as hold from _ty0;
        create temp table _tb as select q, avg(y) as b from _ty where not hold group by q;
        create temp table _ta as select distinct p, 0::float8 as a from _ty;
        for i in 1..20 loop
          update _ta set a = s.v from (select y.p, avg(y.y - b.b) as v from _ty y join _tb b using (q) where not y.hold group by y.p) s where _ta.p = s.p;
          update _tb set b = s.v from (select y.q, avg(y.y - a.a) as v from _ty y join _ta a using (p) where not y.hold group by y.q) s where _tb.q = s.q;
        end loop;
        create temp table _td as
          select u.p, coalesce(x.dec, 1) as dec from _tu u
          left join (select a.p, ntile(10) over (order by a.a) as dec from _ta a
                      where exists (select 1 from _ty y where y.p = a.p and not y.hold)) x using (p);
        create temp table _tcell as
          select y.q, d.dec, avg(y.price) as m from _ty y join _td d using (p) where not y.hold group by y.q, d.dec;
        if f >= 0 then
          insert into _tres
          select y.q, f,
                 sum(coalesce(c.m, (select avg(c2.m) from _tcell c2 where c2.q = y.q and abs(c2.dec - d.dec) = 1),
                                   (select avg(c3.m) from _tcell c3 where c3.q = y.q))),
                 sum(y.price), count(*)
            from _ty y join _td d using (p) left join _tcell c on c.q = y.q and c.dec = d.dec
           where y.hold group by y.q;
        end if;
      end loop;

      -- validation: pooled holdout per parallel, with its tier's catalogue coverage
      with par as (
        select r.q, sum(r.n) as n, sum(r.pred) / nullif(sum(r.obs), 0) as ratio,
               (select min(c.tier) from _tc c where c.q = r.q) as tier
          from _tres r group by r.q
      ), cov as (
        select d->>'rarity' as tier, max((d->>'unique_pskus')::numeric) as pskus
          from panini_pack_state s, jsonb_array_elements(s.raw->'pack_config_info'->'rarity_distribution') d
         where s.product_set_id = v_ps and coalesce(s.packs_remaining, 0) > 0
           and jsonb_typeof(s.raw->'pack_config_info'->'rarity_distribution') = 'array'
         group by 1
      ), j as (
        select par.*, (select count(*) from _tc c where c.tier = par.tier)::numeric / nullif(cov.pskus, 0) as coverage
          from par left join cov on cov.tier = par.tier
      )
      select jsonb_agg(jsonb_build_object('parallel', j.q, 'tier', j.tier, 'holdout_n', j.n,
                         'pred_over_obs', round(j.ratio::numeric, 3), 'tier_coverage', round(j.coverage, 3)) order by j.tier, j.q),
             coalesce(bool_and(case when j.coverage >= 0.9 then j.ratio between 0.9 and 1.1
                                    when j.n >= 30 then j.ratio between 0.67 and 1.5
                                    else true end), false)
        into v_val, v_gate
        from j;

      select count(*) into v_live from panini_pack_state s
       where s.product_set_id = v_ps and coalesce(s.packs_remaining, 0) > 0;

      with pk as (
        select s.id, s.cards_per_pack as cpp, s.packs_remaining as rem, s.raw->'pack_config_info'->'rarity_distribution' as rd
          from panini_pack_state s
         where s.product_set_id = v_ps and coalesce(s.packs_remaining, 0) > 0
           and jsonb_typeof(s.raw->'pack_config_info'->'rarity_distribution') = 'array'
      ), tiers as (
        select pk.id, pk.cpp, pk.rem, d->>'rarity' as tier, nullif(d->>'percentage', '')::numeric as pct,
               nullif(d->>'unique_pskus', '')::int as pskus
          from pk, jsonb_array_elements(pk.rd) d
      ), pred as (
        select u.p, tp.q,
               coalesce(c.m, (select avg(c2.m) from _tcell c2 where c2.q = tp.q and abs(c2.dec - d.dec) = 1),
                        (select avg(c3.m) from _tcell c3 where c3.q = tp.q)) as v
          from (select distinct q from _tc) tp cross join _tu u
          join _td d on d.p = u.p
          left join _tcell c on c.q = tp.q and c.dec = d.dec
      ), cat as (
        select t.id, t.tier, count(c.id) as ncat, count(c.price) as npriced,
               sum(c.mc) as cmc, sum(c.mc * coalesce(c.price, pr.v)) as cval,
               sum(c.still) as cstill, sum(c.still * coalesce(c.price, pr.v)) as sval
          from tiers t
          left join _tc c on c.tier = t.tier
          left join pred pr on pr.p = c.p and pr.q = c.q
         group by t.id, t.tier
      ), tpar as (
        select t.id, t.tier, c.q, avg(c.mc) as mc from tiers t join _tc c on c.tier = t.tier group by t.id, t.tier, c.q
      ), cand as (
        select tp.id, tp.tier, avg(pr.v) as ev_m, avg(tp.mc) as mc_m, count(*) as ncand
          from tpar tp join pred pr on pr.q = tp.q
         where not exists (select 1 from _tc c where c.q = tp.q and c.p = pr.p)
         group by tp.id, tp.tier
      ), tt as (
        select t.*, ca.ncat, ca.npriced, ca.cmc, ca.cval, ca.cstill, ca.sval,
               greatest(coalesce(t.pskus, 0) - ca.ncat, 0) as m, cd.ev_m, cd.mc_m, cd.ncand,
               (ca.cval + greatest(coalesce(t.pskus, 0) - ca.ncat, 0) * coalesce(cd.mc_m, 0) * coalesce(cd.ev_m, 0))
                 / nullif(ca.cmc + greatest(coalesce(t.pskus, 0) - ca.ncat, 0) * coalesce(cd.mc_m, 0), 0) as e,
               ca.cval / nullif(ca.cmc, 0) as e_cat
          from tiers t join cat ca using (id, tier) left join cand cd using (id, tier)
      ), rem as (
        -- uncatalogued sealed cards = packs_remaining x cards - catalogued still, allocated by missing cells x mint cap
        select tt.id,
               greatest(max(tt.rem) * max(tt.cpp) - sum(coalesce(tt.cstill, 0)), 0) as gap,
               sum(coalesce(tt.cstill, 0)) as still,
               sum(coalesce(tt.sval, 0)) as sval,
               sum(tt.m * coalesce(tt.mc_m, 0)) as wsum,
               sum(tt.m * coalesce(tt.mc_m, 0) * coalesce(tt.ev_m, 0)) as wval
          from tt group by tt.id
      ), agg as (
        select tt.id, max(tt.cpp) as cpp, max(tt.rem) as rem,
               max(tt.cpp) * sum(tt.pct * tt.e) / nullif(sum(tt.pct) filter (where tt.e is not null), 0) as ev_design,
               max(tt.cpp) * sum(tt.pct * tt.e_cat) / nullif(sum(tt.pct) filter (where tt.e_cat is not null), 0) as ev_cat,
               bool_or(tt.e is null and coalesce(tt.pct, 0) >= 0.1) as tier_unpriced,
               jsonb_agg(jsonb_build_object('tier', tt.tier, 'pct', tt.pct, 'distinct_cards', tt.pskus, 'catalogued', tt.ncat,
                           'priced', tt.npriced, 'missing', tt.m, 'candidates', tt.ncand,
                           'e_usd', round(tt.e::numeric, 2), 'e_catalogued_usd', round(tt.e_cat::numeric, 2),
                           'missing_e_usd', round(tt.ev_m::numeric, 2), 'still', tt.cstill) order by tt.pct desc nulls last) as tiers
          from tt group by tt.id
      )
      insert into panini_pack_ev_tier_shadow as t (pack_id, product_set_id, cards_per_pack, packs_remaining, ev_design_usd,
             ev_catalogued_usd, ev_remaining_usd, published_ev_usd, published_is_floor, tiers, validation, gate_ok,
             players, priced_editions, model_note, computed_at)
      select a.id, v_ps, a.cpp, a.rem,
             case when a.tier_unpriced then null else round(a.ev_design::numeric, 2) end,
             round(a.ev_cat::numeric, 2),
             case when v_live = 1 and not a.tier_unpriced and (r.still + r.gap) > 0 then
               round((a.cpp * (r.sval + case when r.wsum > 0 then r.gap * r.wval / r.wsum else 0 end) / (r.still + r.gap))::numeric, 2) end,
             b.actual_ev_usd, b.ev_is_floor, a.tiers, v_val, v_gate, v_players, v_priced,
             'SHADOW · tier-composition model · not published · ' ||
               case when a.tier_unpriced then 'a tier with >= 0.1 % of cards has no priced or predictable card · '  else '' end ||
               case when v_live = 1 then 'remaining EV from ' || r.gap || ' uncatalogued sealed cards' else 'remaining EV n/a (' || v_live || ' live packs share this product)' end,
             now()
        from agg a join rem r using (id)
        left join panini_pack_ev_board b on b.id = a.id
      on conflict (pack_id) do update set product_set_id = excluded.product_set_id, cards_per_pack = excluded.cards_per_pack,
             packs_remaining = excluded.packs_remaining, ev_design_usd = excluded.ev_design_usd,
             ev_catalogued_usd = excluded.ev_catalogued_usd, ev_remaining_usd = excluded.ev_remaining_usd,
             published_ev_usd = excluded.published_ev_usd, published_is_floor = excluded.published_is_floor,
             tiers = excluded.tiers, validation = excluded.validation, gate_ok = excluded.gate_ok,
             players = excluded.players, priced_editions = excluded.priced_editions,
             model_note = excluded.model_note, computed_at = excluded.computed_at;
      get diagnostics v_n = row_count;
      v_packs := v_packs + v_n;
      v_done := v_done + 1;
    exception when others then
      v_errors := v_errors || jsonb_build_object('product_set_id', v_ps, 'error', sqlerrm);
    end;
  end loop;

  perform public.log_pipeline_run('panini-pack-ev-tier-shadow', jsonb_array_length(v_errors) = 0,
    jsonb_build_object('products', v_done, 'packs_written', v_packs, 'errors', jsonb_array_length(v_errors),
                       'error_sample', v_errors -> 0, 'ms', round(extract(epoch from clock_timestamp() - v_started) * 1000)));
  return jsonb_build_object('ok', jsonb_array_length(v_errors) = 0, 'products', v_done, 'packs', v_packs, 'errors', v_errors);
exception when query_canceled or others then
  perform public.log_pipeline_run('panini-pack-ev-tier-shadow', false, jsonb_build_object('error', sqlerrm, 'products', v_done));
  return jsonb_build_object('ok', false, 'error', sqlerrm);
end;
$function$;
revoke execute on function public.refresh_panini_pack_ev_tier_shadow() from public, anon, authenticated;
grant execute on function public.refresh_panini_pack_ev_tier_shadow() to postgres, service_role;

select cron.schedule('panini-pack-ev-tier-shadow', '49 * * * *', $$select public.refresh_panini_pack_ev_tier_shadow()$$);
