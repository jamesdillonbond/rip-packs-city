-- Comparable-edition FMV estimate (model "comp-1.0", 2026-11-12, Cowork; Trevor: "come up with predictive fmv for moments without sales yet").
-- For EVERY edition of the four editions-table markets it stores a price estimated ONLY from OTHER editions:
--   baseline = geometric mean of the sale-backed FMV of the edition's set-mates (same set + same parallel),
--              falling back to same tier/series/mint-size bucket, then same tier;
--   premium  = the player's average log-ratio to baseline across the player's OTHER sale-backed editions, shrunk m/(m+1).
-- The edition's own price never enters its own estimate, so the table is its own leave-one-out backtest.
-- SHADOW ONLY: nothing reads this table on a user-facing surface and it never writes fmv_snapshots.
-- anon-exec: refresh_fmv_comparable_estimates is NOT anon-executable (EXECUTE revoked from public, anon, authenticated).
-- Revert: remove function public.refresh_fmv_comparable_estimates() and table public.fmv_comparable_estimates.
create table public.fmv_comparable_estimates (
  edition_id uuid primary key,
  collection_id uuid not null,
  own_fmv_usd numeric,
  own_confidence text,
  baseline_kind text,
  baseline_usd numeric,
  n_set int, n_bucket int, n_tier int,
  player_premium numeric,
  n_player int,
  est_usd numeric,
  model_version text not null,
  computed_at timestamptz not null default now()
);
alter table public.fmv_comparable_estimates enable row level security;
revoke all on public.fmv_comparable_estimates from anon, authenticated;

create or replace function public.refresh_fmv_comparable_estimates()
returns integer language plpgsql set search_path = public, pg_temp set statement_timeout = '120s' as $fn$
declare n integer;
begin
  with canon as (
    select e.id, e.collection_id, e.set_id, coalesce(e.subedition_id, 0) sub, e.tier::text tier, coalesce(e.series, -1) series,
           case when e.circulation_count > 0 then floor(log(2, e.circulation_count::numeric))::int else -1 end cb,
           coalesce(e.player_id::text, nullif(e.player_name, '')) pk,
           f.fmv_usd own_fmv, f.confidence::text own_conf,
           case when f.fmv_usd > 0 and f.confidence::text in ('HIGH','MEDIUM','LOW') then ln(f.fmv_usd) end lg
    from editions e
    join collections c on c.id = e.collection_id
    left join edition_fmv_current f on f.edition_id = e.id
    where c.slug in ('nba_top_shot','nfl_all_day','laliga_golazos','candy_mlb')
      and (c.slug <> 'nba_top_shot' or e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
  ), w1 as (
    select *, (lg is not null)::int own,
      sum(lg) over ws s_set, count(lg) over ws c_set,
      sum(lg) over wb s_b, count(lg) over wb c_b,
      sum(lg) over wt s_t, count(lg) over wt c_t
    from canon
    window ws as (partition by collection_id, set_id, sub),
           wb as (partition by collection_id, tier, series, (sub > 0), cb),
           wt as (partition by collection_id, tier, (sub > 0))
  ), w2 as (
    select *,
      case when set_id is not null then c_set - own else 0 end n_set, c_b - own n_bucket, c_t - own n_tier,
      case when set_id is not null and c_set - own > 0 then (s_set - coalesce(lg, 0)) / (c_set - own) end m_set,
      case when c_b - own > 0 then (s_b - coalesce(lg, 0)) / (c_b - own) end m_b,
      case when c_t - own > 0 then (s_t - coalesce(lg, 0)) / (c_t - own) end m_t
    from w1
  ), w3 as (
    select *,
      case when n_set >= 2 then 'set' when n_bucket >= 3 then 'bucket' when n_tier >= 3 then 'tier' end bkind,
      case when n_set >= 2 then m_set when n_bucket >= 3 then m_b when n_tier >= 3 then m_t end base
    from w2
  ), w4 as (
    select *, lg - base resid from w3
  ), w5 as (
    select *, sum(resid) over wp rp, count(resid) over wp cp
    from w4 window wp as (partition by collection_id, pk)
  ), fin as (
    select id, collection_id, own_fmv, own_conf, bkind, base, n_set, n_bucket, n_tier,
      case when pk is not null and cp - (resid is not null)::int > 0
           then (rp - coalesce(resid, 0)) / (cp - (resid is not null)::int) end prem,
      case when pk is not null then cp - (resid is not null)::int else 0 end n_player
    from w5
  )
  insert into fmv_comparable_estimates as t
    (edition_id, collection_id, own_fmv_usd, own_confidence, baseline_kind, baseline_usd, n_set, n_bucket, n_tier,
     player_premium, n_player, est_usd, model_version, computed_at)
  select id, collection_id, own_fmv, own_conf, bkind, round(exp(base)::numeric, 4), n_set, n_bucket, n_tier,
         round(prem::numeric, 4), n_player,
         round(exp(base + coalesce(prem * n_player / (n_player + 1.0), 0))::numeric, 2),
         'comp-1.0', now()
  from fin
  on conflict (edition_id) do update set
    collection_id = excluded.collection_id, own_fmv_usd = excluded.own_fmv_usd, own_confidence = excluded.own_confidence,
    baseline_kind = excluded.baseline_kind, baseline_usd = excluded.baseline_usd, n_set = excluded.n_set,
    n_bucket = excluded.n_bucket, n_tier = excluded.n_tier, player_premium = excluded.player_premium,
    n_player = excluded.n_player, est_usd = excluded.est_usd, model_version = excluded.model_version, computed_at = excluded.computed_at;
  get diagnostics n = row_count;
  return n;
end $fn$;
revoke all on function public.refresh_fmv_comparable_estimates() from public, anon, authenticated;