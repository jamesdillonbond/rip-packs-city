-- anon-exec: NOT granted - check_pipeline_cadence_collapse is SECURITY DEFINER and
-- anon/authenticated EXECUTE both read FALSE live on 2026-09-19 (service_role true,
-- exactly one overload). This is a SNAPSHOT migration: CREATE OR REPLACE does not reset
-- a function ACL, so a REVOKE here would be a production ACL change smuggled into a body
-- swap. The decision is already made and is unchanged by this migration.
--
-- ⚠ The comment lines above are the ONLY divergence from what prod stored for this
-- migration. The SQL from the CREATE line down is byte-identical to the applied
-- statement (md5 83e5334f080b942cb0ffb3777320d31e over that slice, verified).
CREATE OR REPLACE FUNCTION public.check_pipeline_cadence_collapse(p_baseline_days integer DEFAULT 14, p_exclude_days integer DEFAULT 3, p_window_hours integer DEFAULT 12, p_ratio numeric DEFAULT 0.40, p_min_baseline integer DEFAULT 24)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with exempt as (
    -- Lanes whose run count is DEMAND, not cadence (public.cadence_exempt_lanes).
    -- ⛔ An exemption past its review_by is NOT applied: it stops suppressing and
    -- the lane fires again. Fail-loud is deliberate -- a suppression nobody ever
    -- re-examines is the "filed DECISION NOT TO ACT that nobody re-checks".
    select e.pipeline_pattern, e.reason
    from public.cadence_exempt_lanes e
    where e.review_by >= current_date
  ),
  expired as (
    select e.pipeline_pattern, e.review_by
    from public.cadence_exempt_lanes e
    where e.review_by < current_date
  ),
  base as (
    select
      d.pipeline,
      percentile_cont(0.5) within group (order by d.runs)::numeric as baseline_per_day,
      count(*)                                                     as baseline_days_seen
    from public.pipeline_runs_daily d
    where d.day >= current_date - (p_baseline_days + p_exclude_days)
      and d.day <  current_date - p_exclude_days
      and d.pipeline not like '%-heartbeat'
    group by d.pipeline
  ),
  obs as (
    select
      r.pipeline,
      count(*)::numeric * 24.0 / greatest(p_window_hours, 1) as observed_per_day,
      count(*)                                              as observed_runs
    from public.pipeline_runs r
    where r.started_at > now() - make_interval(hours => greatest(p_window_hours, 1))
    group by r.pipeline
  ),
  last_seen as (
    -- R102 (2026-09-18). The published `last_run_at` used to come from `obs`, i.e.
    -- from the OBSERVATION WINDOW, so a lane with zero runs in the last 12 h got a
    -- NULL through the left join and the payload said "last_run_at": null for
    -- eight lanes whose last run was plainly readable in pipeline_runs. The field
    -- NAME claims "when did this lane last run"; the value answered a different
    -- question, inside a SAFETY instrument. That is the #80 mirror defect -- an
    -- `unknown` that is actually KNOWN -- and it cost a pass a false "these lanes
    -- never resumed after the outage" reading.
    --
    -- Bounded at 72 h deliberately: pipeline_runs retains ~73 h, so this is the
    -- whole readable history and NOT an unbounded scan of a partitioned table on an
    -- IO-constrained instance. A lane silent longer than that publishes null, which
    -- is then the true answer for this instrument rather than an artifact.
    select r.pipeline, max(r.started_at) as last_run_at
    from public.pipeline_runs r
    where r.started_at > now() - interval '72 hours'
    group by r.pipeline
  ),
  scored as (
    select
      b.pipeline,
      b.baseline_per_day,
      b.baseline_days_seen,
      coalesce(o.observed_per_day, 0) as observed_per_day,
      coalesce(o.observed_runs, 0)    as observed_runs,
      l.last_run_at,
      case when b.baseline_per_day > 0
           then round(coalesce(o.observed_per_day, 0) / b.baseline_per_day, 3)
           else null end              as ratio
    from base b
    left join obs o       on o.pipeline = b.pipeline
    left join last_seen l on l.pipeline = b.pipeline
    where b.baseline_per_day >= p_min_baseline
  ),
  raw_hits as (
    select *,
           case when observed_runs = 0 then 'stopped' else 'degraded' end as state
    from scored
    where observed_per_day < p_ratio * baseline_per_day
  ),
  -- ⚠ A lane matching TWO patterns must not become two rows: the lateral picks
  -- exactly one, so `suppressed` and `hits` stay a partition of `raw_hits` and
  -- the counts cannot double-count.
  suppressed as (
    select h.*, e.pipeline_pattern, e.reason
    from raw_hits h
    cross join lateral (
      select e2.pipeline_pattern, e2.reason
      from exempt e2
      where h.pipeline like e2.pipeline_pattern
      order by e2.pipeline_pattern
      limit 1
    ) e
  ),
  hits as (
    select h.* from raw_hits h
    where not exists (
      select 1 from exempt e where h.pipeline like e.pipeline_pattern
    )
  )
  select jsonb_build_object(
    'inspected',           (select count(*) from scored),
    'window',              jsonb_build_object(
                             'baseline_days', p_baseline_days,
                             'exclude_days',  p_exclude_days,
                             'window_hours',  p_window_hours,
                             'ratio',         p_ratio,
                             'min_baseline',  p_min_baseline,
                             'last_run_lookback_hours', 72),
    'baseline_window',     jsonb_build_object(
                             'from', (current_date - (p_baseline_days + p_exclude_days))::text,
                             'to',   (current_date - p_exclude_days)::text),
    'excluded_heartbeats', (select count(distinct d.pipeline) from public.pipeline_runs_daily d
                             where d.day >= current_date - (p_baseline_days + p_exclude_days)
                               and d.day <  current_date - p_exclude_days
                               and d.pipeline like '%-heartbeat'),
    'degraded_count',      (select count(*) from hits where state = 'degraded'),
    'stopped_count',       (select count(*) from hits where state = 'stopped'),
    -- ⭐ Suppression is REPORTED, never a silent skip. A reader can see exactly
    -- what would have fired, at what ratio, and on whose stated reason.
    'suppressed_count',    (select count(*) from suppressed),
    'suppressed',          coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',         s.pipeline,
               'state',            s.state,
               'ratio',            s.ratio,
               'observed_per_day', s.observed_per_day,
               'baseline_per_day', s.baseline_per_day,
               'pattern',          s.pipeline_pattern,
               'reason',           s.reason
             ) order by s.ratio)
      from suppressed s), '[]'::jsonb),
    -- An exemption past review_by is already NOT suppressing (see `exempt`).
    -- Naming it here is what turns that from a surprise into a scheduled review.
    'expired_exemptions',  coalesce((
      select jsonb_agg(jsonb_build_object(
               'pattern',      x.pipeline_pattern,
               'review_by',    x.review_by::text,
               'days_expired', (current_date - x.review_by)
             ) order by x.review_by)
      from expired x), '[]'::jsonb),
    'degraded',            coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',         h.pipeline,
               'baseline_per_day', h.baseline_per_day,
               'observed_per_day', h.observed_per_day,
               'observed_runs',    h.observed_runs,
               'ratio',            h.ratio,
               'last_run_at',      h.last_run_at,
               'hours_since_last_run',
                 case when h.last_run_at is null then null
                      else round(extract(epoch from (now() - h.last_run_at))::numeric / 3600.0, 2) end
             ) order by h.ratio)
      from hits h where h.state = 'degraded'), '[]'::jsonb),
    'stopped',             coalesce((
      select jsonb_agg(jsonb_build_object(
               'pipeline',         h.pipeline,
               'last_run_at',      h.last_run_at,
               'hours_since_last_run',
                 case when h.last_run_at is null then null
                      else round(extract(epoch from (now() - h.last_run_at))::numeric / 3600.0, 2) end,
               'ran_within_retention', (h.last_run_at is not null)
             ) order by h.pipeline)
      from hits h where h.state = 'stopped'), '[]'::jsonb)
  );
$function$;
