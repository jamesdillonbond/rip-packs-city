-- audit_20260910_site_availability_probe_from_the_one_plane_a_vercel_pause_cannot_reach
--
-- WHY. On 2026-09-10 a Vercel SPEND-CAP pause took the site down for ~10 hours
-- and it was found BY ACCIDENT (#76). Every detector that should have said so
-- was either a casualty of the same pause or asleep:
--   * the sentinel is an HTTP route, so it 503s BEFORE log_pipeline_run and
--     reads as SILENT rather than FAILING;
--   * alerts-dispatch / alerts-send sit behind the same paused deployment;
--   * Scheduler liveness is DAILY -- a ~23h blind window the outage began inside.
-- Trevor raised the budget only SLIGHTLY, so this CAN recur and will look
-- identical when it does.
--
-- THE POINT OF PUTTING IT HERE. Postgres is the one plane that survived the
-- entire outage: pg_cron kept firing and pg_net kept reaching the internet while
-- Vercel served 503s. A probe that lives in the database CANNOT be a casualty of
-- the thing it is watching. That is the property no existing detector had.
--
-- WHAT IT IS NOT. This records availability; it does not notify. No edge
-- function here has a Telegram path and no Telegram secret exists in GitHub
-- Actions, so a fully Vercel-independent ALERT needs a credential that is
-- Trevor's to add. The reader below is built so a GitHub Actions step -- which
-- already holds SUPABASE_SERVICE_ROLE_KEY and is itself independent of Vercel --
-- can fail loudly on it, which is the notify half using only what exists today.
--
-- ENDPOINT CHOICE. /api/health is the documented liveness route and its own
-- header says it "MUST NOT have heavy dependencies" -- it returns a static JSON
-- 200 and touches no database. Probing anything heavier would turn this into a
-- failure correlator rather than an availability signal, which is the mistake
-- that route's comment was written to prevent.

create table if not exists public.site_probe (
  id          bigserial primary key,
  request_id  bigint,
  url         text        not null,
  fired_at    timestamptz not null default now(),
  status_code int,
  error_msg   text,
  resolved_at timestamptz
);

create index if not exists idx_site_probe_fired_at on public.site_probe (fired_at desc);
create index if not exists idx_site_probe_request_id on public.site_probe (request_id);

comment on table public.site_probe is
  'One row per DB-side availability probe of the public site (#76). pg_net is async: the row is inserted with request_id at dispatch and resolved from net._http_response on the NEXT tick. status_code 200 = serving; 503 = a Vercel pause (DEPLOYMENT_PAUSED); NULL with error_msg = the request never completed. request_id is recorded so the 4xx arm can ATTRIBUTE this lane instead of reporting it as an unknown critical.';

alter table public.site_probe enable row level security;
revoke all on public.site_probe from public, anon, authenticated;
grant select, insert, update, delete on public.site_probe to postgres, service_role;
grant usage, select on sequence public.site_probe_id_seq to postgres, service_role;

create or replace function public.probe_site_health()
returns void
language plpgsql
security definer
set search_path = public, pg_temp, net
as $$
DECLARE
  v_url text := 'https://www.rippackscity.com/api/health';
BEGIN
  -- 1. Resolve whatever the PREVIOUS tick dispatched. pg_net writes the response
  --    row asynchronously, so a probe is always read one tick after it is fired.
  UPDATE public.site_probe p
     SET status_code = r.status_code,
         error_msg   = r.error_msg,
         resolved_at = now()
    FROM net._http_response r
   WHERE r.id = p.request_id
     AND p.resolved_at IS NULL;

  -- 2. A request with no response row after 20 minutes will never get one
  --    (pg_net TTL is 6h, and this probe times out in 8s). Close it as UNKNOWN
  --    rather than leaving it pending forever, where it would read as "still in
  --    flight" and quietly shrink the denominator of every availability read.
  UPDATE public.site_probe
     SET resolved_at = now(),
         error_msg   = COALESCE(error_msg, 'no pg_net response row within 20m')
   WHERE resolved_at IS NULL
     AND fired_at < now() - interval '20 minutes';

  -- 3. Fire the next probe and record its id, so the 4xx arm can attribute it.
  INSERT INTO public.site_probe (request_id, url)
  SELECT net.http_get(url := v_url, timeout_milliseconds := 8000), v_url;

  -- 4. Cheap rolling prune. 288 rows/day; 30 days is ample for dating an outage.
  DELETE FROM public.site_probe WHERE fired_at < now() - interval '30 days';
END;
$$;

comment on function public.probe_site_health() is
  'Resolves the previous availability probe from net._http_response, then dispatches the next one. Driven by pg_cron so it survives a Vercel pause (#76).';

revoke execute on function public.probe_site_health() from public, anon, authenticated;
grant execute on function public.probe_site_health() to postgres, service_role;

create or replace function public.check_site_availability(p_window interval default '2 hours')
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  WITH w AS (
    SELECT * FROM public.site_probe
     WHERE fired_at > now() - p_window AND resolved_at IS NOT NULL
  ),
  latest AS (
    SELECT * FROM w ORDER BY fired_at DESC LIMIT 1
  ),
  -- Consecutive failures from the newest backwards. This is the number an alarm
  -- should key on: one failed probe is a blip, several in a row is an outage.
  streak AS (
    SELECT count(*)::int AS n
      FROM (
        SELECT status_code,
               row_number() OVER (ORDER BY fired_at DESC) AS rn,
               sum(CASE WHEN status_code = 200 THEN 1 ELSE 0 END)
                 OVER (ORDER BY fired_at DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ok_seen
          FROM w
      ) s
     WHERE ok_seen = 0
  )
  SELECT jsonb_build_object(
    -- The population is published so a window that probed NOTHING cannot read as
    -- a window in which nothing went wrong.
    'probes',            (SELECT count(*)::int FROM w),
    'ok',                (SELECT count(*) FILTER (WHERE status_code = 200)::int FROM w),
    'failed',            (SELECT count(*) FILTER (WHERE status_code IS DISTINCT FROM 200)::int FROM w),
    'consecutive_fails', COALESCE((SELECT n FROM streak), 0),
    'latest_status',     (SELECT status_code FROM latest),
    'latest_error',      (SELECT left(error_msg, 200) FROM latest),
    'latest_at',         (SELECT fired_at FROM latest),
    'last_ok_at',        (SELECT max(fired_at) FROM w WHERE status_code = 200),
    'window',            p_window::text
  );
$$;

comment on function public.check_site_availability(interval) is
  'Availability of the public site as seen from INSIDE the database, which a Vercel pause cannot silence (#76). consecutive_fails is the alarm number; probes is published so an empty window cannot read as a healthy one.';

revoke execute on function public.check_site_availability(interval) from public, anon, authenticated;
grant execute on function public.check_site_availability(interval) to postgres, service_role;

-- Scheduled separately at apply time (pg_cron jobs are not DDL):
--   select cron.schedule('rpc-site-availability-probe', '2-57/5 * * * *',
--                        'SELECT public.probe_site_health()');   -- jobid 483
-- Revert: select cron.unschedule('rpc-site-availability-probe');
