-- audit_20261113_comparable_estimate_skips_one_of_ones
--
-- Claude Code cloud, 2026-11-13 ~12:15 PM PT. One change to refresh_fmv_comparable_estimates (comp-1.1, pg_cron 868,
-- 36 1,7,13,19 UTC): an edition with circulation_count = 1 gets est_usd / parallel_est_usd NULL.
--
-- WHY. The estimate's set baseline is the mean log price of the edition's set-mates and ignores circulation (only
-- the bucket fallback keys on it), so a one-of-one in a set of /5,000 commons was "estimated" at its commons' level.
-- Trevor's rule for the parallel estimate (schema-truth.md, edition_fmv_estimates): "no estimate for a 1/1 — every
-- Omega is one". This path never applied it. Live 11-13 ~12:15 PM PT: 1/1 editions carrying a comparable estimate —
-- Candy 79 (70 unpriced, shown as "Estimated value"), All Day 56 (51), Top Shot 46 (22); 2 priced by a _compcap cut.
-- Found by an independent review of the 11-12 FMV commits.
--
-- EFFECT. The function UPSERTS every edition it scores, so the next run (<= 6 h) rewrites those rows with NULL
-- estimates; every reader already skips a NULL: both _compcap triggers require est_usd > 0 / >= 0.01, and
-- lib/fmv/edition-estimate.ts parseComparableRow returns null (no card, no concierge value_estimate).
-- Base verified: live prosrc md5 6d276b6cd15927cea5f839b345047018 (= 20261112163401). The DO block refuses if moved.
-- anon-exec: unchanged (refresh_fmv_comparable_estimates) — CREATE OR REPLACE of an existing fn; ACL preserved.
-- Caller: pg_cron 868 rpc-refresh-fmv-comparable-estimates only.
--
-- APPLIED 2026-11-13 ~12:16 PM PT (recorded 20261113201624): live prosrc md5 81e70f35fc8bd7750a4fb0e6f74ca068 = this
-- file's body. Ran once by hand through the cron's own wrapper (run_refresh_fmv_comparable_estimates: ok, 46,153 rows,
-- the usual count). After: 0 one-of-ones carry est_usd in any collection; every other edition kept its estimate
-- (Candy 13,464 · Top Shot 14,417 · All Day 5,690 · Golazos 554).
-- REVERT: re-create the 20261112163401 body.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_fmv_comparable_estimates()'::regprocedure)
     <> '6d276b6cd15927cea5f839b345047018' THEN
    RAISE EXCEPTION 'refresh_fmv_comparable_estimates changed since it was read; re-derive this migration';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.refresh_fmv_comparable_estimates()
returns integer language plpgsql set search_path = public, pg_temp set statement_timeout = '120s' as $fn$
declare n integer;
begin
  with canon as (
    select e.id, e.collection_id, e.set_id, coalesce(e.subedition_id, 0) sub, e.tier::text tier, coalesce(e.series, -1) series,
           case when e.circulation_count > 0 then floor(log(2, e.circulation_count::numeric))::int else -1 end cb,
           coalesce(e.player_id::text, nullif(e.player_name, '')) pk,
           e.circulation_count circ,
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
    select id, collection_id, circ, own_fmv, own_conf, bkind, base, n_set, n_bucket, n_tier,
      case when pk is not null and cp - (resid is not null)::int > 0
           then (rp - coalesce(resid, 0)) / (cp - (resid is not null)::int) end prem,
      case when pk is not null then cp - (resid is not null)::int else 0 end n_player
    from w5
  ), par as (
    select distinct on (e.id) e.id, e.subedition_id sub, e.tier::text tier,
      case when f.fmv_usd > 0 and f.confidence::text in ('HIGH','MEDIUM','LOW') then ln(f.fmv_usd) end lg,
      case when bf.fmv_usd > 0 and bf.confidence::text in ('HIGH','MEDIUM','LOW') then ln(bf.fmv_usd) end lgb
    from editions e
    join editions b on b.collection_id = e.collection_id and b.external_id = split_part(e.external_id, '::', 1)
    left join edition_fmv_current f on f.edition_id = e.id
    left join edition_fmv_current bf on bf.edition_id = b.id
    where e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' and e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
    order by e.id
  ), pw as (
    select *, (lg is not null and lgb is not null)::int own2,
      sum(lg - lgb) over c s, count(lg - lgb) over c cn
    from par window c as (partition by sub, tier)
  ), pe as (
    select id, (cn - own2)::int n_cell,
      case when lgb is not null and cn - own2 >= 5 then exp(lgb + (s - coalesce(lg - lgb, 0)) / (cn - own2)) end pr
    from pw
  ), outp as (
    select fin.*, pe.pr, pe.n_cell,
      case when fin.base is not null then exp(fin.base + coalesce(fin.prem * fin.n_player / (fin.n_player + 1.0), 0)) end comp
    from fin left join pe on pe.id = fin.id
  )
  insert into fmv_comparable_estimates as t
    (edition_id, collection_id, own_fmv_usd, own_confidence, baseline_kind, baseline_usd, n_set, n_bucket, n_tier,
     player_premium, n_player, est_usd, parallel_est_usd, n_parallel_cell, model_version, computed_at)
  select id, collection_id, own_fmv, own_conf, bkind, round(exp(base)::numeric, 4), n_set, n_bucket, n_tier,
         round(prem::numeric, 4), n_player,
         -- 2026-11-13: no estimate for a 1/1 (Trevor's rule for the parallel estimate, "every Omega is one"): the set
         -- baseline ignores circulation, so a one-of-one was priced at its set-mates' level.
         case when circ = 1 then null else
         round((case when pr is not null and comp is not null then sqrt(pr * comp) when pr is not null then pr else comp end)::numeric, 2) end,
         case when circ = 1 then null else round(pr::numeric, 2) end, n_cell, 'comp-1.1', now()
  from outp
  on conflict (edition_id) do update set
    collection_id = excluded.collection_id, own_fmv_usd = excluded.own_fmv_usd, own_confidence = excluded.own_confidence,
    baseline_kind = excluded.baseline_kind, baseline_usd = excluded.baseline_usd, n_set = excluded.n_set,
    n_bucket = excluded.n_bucket, n_tier = excluded.n_tier, player_premium = excluded.player_premium,
    n_player = excluded.n_player, est_usd = excluded.est_usd, parallel_est_usd = excluded.parallel_est_usd,
    n_parallel_cell = excluded.n_parallel_cell, model_version = excluded.model_version, computed_at = excluded.computed_at;
  get diagnostics n = row_count;
  return n;
end $fn$;
