-- audit_20261026: Panini COLLECTION VALUE history (Top Shot parity: the profile's portfolio value
-- over time, /api/profile/portfolio-history). Top Shot computes it on demand from daily
-- fmv_snapshots; Panini's snapshots are written on CHANGE (~7 per edition in 30 days, measured
-- 10-26), so summing "that day's snapshots" would swing with whichever editions happened to be
-- repriced, and the on-demand read costs 4.3 s cold on a 7.6k-card profile. So this RECORDS it:
--   · panini_portfolio_daily — one row per walked collector per PT day: cards held (profile as
--     last walked, minus cards the marketplace shows under another owner — panini_holdings_breakdown),
--     how many are priced, their FMV total, and whether the walk behind it read the whole profile.
--     Nothing is back-filled: history starts the first day this runs (stated by the reader).
--   · refresh_panini_portfolio_daily() — daily at 6:33 AM PDT (13:33 UTC), after the morning
--     collector walks; public profiles walked in the last 3 days only. A same-day rerun updates the
--     day's row in place. ok is DERIVED from the writes: any collector that fails is counted in
--     extra.errors and fails the run (CLAUDE.md write-side honesty).
-- Revert: SELECT cron.unschedule('panini-portfolio-daily'); then remove refresh_panini_portfolio_daily()
--         and the panini_portfolio_daily table (no reader outside /api/panini-collection).

-- anon-exec: revoked (refresh_panini_portfolio_daily) — new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE TABLE IF NOT EXISTS public.panini_portfolio_daily (
  username          text        NOT NULL,
  day               date        NOT NULL,
  cards             integer     NOT NULL,
  priced_cards      integer     NOT NULL,
  fmv_usd           numeric,
  walk_complete     boolean     NOT NULL,
  reported_total    integer,
  last_walk_at      timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (username, day)
);

ALTER TABLE public.panini_portfolio_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_portfolio_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_portfolio_daily TO service_role;

COMMENT ON TABLE public.panini_portfolio_daily IS
  'Panini collection value history (Top Shot parity, audit_20261026): one row per walked public collector per PT day — cards held per the last profile walk (minus cards now shown under another owner), priced cards, FMV total of the priced cards (NULL when none priced, never 0), and whether that walk read the whole profile. Recorded forward only; nothing back-filled.';

CREATE OR REPLACE FUNCTION public.refresh_panini_portfolio_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_day     date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  v_rows    integer := 0;
  v_errors  integer := 0;
  v_users   integer := 0;
  v_last    text := NULL;
  r         record;
  b         jsonb;
BEGIN
  FOR r IN
    SELECT w.username, w.last_walk_at, w.last_complete_at, w.reported_total
      FROM public.panini_collector_walks w
     WHERE w.profile_state = 'public'
       AND w.last_walk_at > now() - interval '3 days'
     ORDER BY w.username
  LOOP
    v_users := v_users + 1;
    BEGIN
      b := public.panini_holdings_breakdown(r.username, NULL, NULL, NULL, NULL, NULL, 1);
      IF b IS NULL OR b->>'source' IS DISTINCT FROM 'profile' THEN
        -- No profile holdings behind a public walk: record nothing rather than a seen-only total.
        CONTINUE;
      END IF;
      INSERT INTO public.panini_portfolio_daily AS d
        (username, day, cards, priced_cards, fmv_usd, walk_complete, reported_total, last_walk_at, recorded_at)
      VALUES (r.username, v_day, (b->>'total_cards')::int, (b->>'fmv_priced_cards')::int,
              NULLIF(b->>'fmv_usd', '')::numeric,
              (r.last_complete_at IS NOT NULL AND r.last_complete_at = r.last_walk_at),
              r.reported_total, r.last_walk_at, v_started)
      ON CONFLICT (username, day) DO UPDATE SET
        cards = EXCLUDED.cards, priced_cards = EXCLUDED.priced_cards, fmv_usd = EXCLUDED.fmv_usd,
        walk_complete = EXCLUDED.walk_complete, reported_total = EXCLUDED.reported_total,
        last_walk_at = EXCLUDED.last_walk_at, recorded_at = EXCLUDED.recorded_at;
      v_rows := v_rows + 1;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_errors := v_errors + 1;
      v_last := SQLERRM;
    END;
  END LOOP;

  PERFORM public.log_pipeline_run('panini-portfolio-daily', v_started, v_users, v_rows, 0, v_errors = 0,
    CASE WHEN v_errors > 0 THEN v_errors || ' collector(s) failed; last: ' || v_last END,
    'panini_blockchain', NULL, NULL,
    jsonb_build_object('source', 'audit_20261026', 'day', v_day, 'collectors', v_users, 'written', v_rows, 'errors', v_errors));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-portfolio-daily', v_started, v_users, v_rows, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261026', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_portfolio_daily() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_portfolio_daily() TO postgres, service_role;

SELECT cron.schedule('panini-portfolio-daily', '33 13 * * *', $$SELECT public.refresh_panini_portfolio_daily()$$);
