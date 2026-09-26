-- audit_20260925_one_quota_for_every_account_and_resync_logs_name_their_caller
--
-- (1) Trevor 2026-09-25: no paid account is considered anywhere until 100 weekly active users.
--     The per-plan quotas still gave the 20 lifetime-Pro beta invitees (pro_grandfather) and any
--     trial/paid/moments_payment plan more than free: concierge 200/day (free 40), API 10,000
--     (free 100), MCP 5,000 (free 100). Every non-operator plan now gets the FREE value.
--     Measured first: in the last 30 days no pro_grandfather wallet recorded a single
--     concierge / api_requests / mcp_query event, so nobody's usage is cut. founding (Trevor) and
--     admin stay unlimited: operator accounts, not a paid tier. custom_alerts_max is untouched:
--     nothing reads it (/api/alerts applies no quota), so changing it would change nothing.
--     saved_wallets_max is already 5 for every plan (20260926012810).
--
-- (2) The two resync functions from this session logged 'via' = 'pg_cron' unconditionally, so a
--     hand-run (e.g. the ~7:34 PM PT first pass of resync_stuck_wmc_fmv) was recorded as a cron run.
--     'via' now derives from session_user (cron_heavy → 'pg_cron', anything else →
--     'manual:<role>'). Bodies otherwise VERBATIM from their defining migrations (read immediately
--     before this one; both created earlier today by this session and untouched since).
--
-- anon-exec: unchanged (run_candy_wmc_fmv_resync_job) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
-- anon-exec: unchanged (resync_stuck_wmc_fmv) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
--
-- REVERT (1): UPDATE public.feature_quotas SET daily_limit = CASE plan
--               WHEN 'pro_trial' THEN CASE feature_name WHEN 'concierge_messages' THEN 50 ELSE 1000 END
--               ELSE CASE feature_name WHEN 'concierge_messages' THEN 200 WHEN 'api_requests' THEN 10000 ELSE 5000 END END
--             WHERE feature_name IN ('concierge_messages','api_requests','mcp_query')
--               AND plan IN ('pro_grandfather','pro_paid','pro_trial','moments_payment');
-- REVERT (2): re-apply the bodies from 20260926020644 and 20260926023408 (stuck resync).

UPDATE public.feature_quotas q
   SET daily_limit = f.daily_limit, updated_at = now(),
       notes = 'Same as free for every account (2026-09-25: no paid tier until 100 WAU)'
  FROM public.feature_quotas f
 WHERE f.plan = 'free'
   AND f.feature_name = q.feature_name
   AND q.feature_name IN ('concierge_messages', 'api_requests', 'mcp_query')
   AND q.plan IN ('pro_grandfather', 'pro_paid', 'pro_trial', 'moments_payment');

CREATE OR REPLACE FUNCTION public.run_candy_wmc_fmv_resync_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ok      boolean := true;
  v_err     text := NULL;
  v_updated int := NULL;
  c_candy   constant uuid := '209ade70-32c5-4470-bc7c-4793d660f713';
BEGIN
  BEGIN
    v_updated := public.populate_wmc_fmv_from_snapshots(c_candy, true, 50000);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- includes 57014 from a statement_timeout: the row below still lands, and
    -- rows_written stays NULL (not 0) because nothing is known to have been written.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run('candy-wmc-fmv-resync', v_started, NULL, v_updated, NULL, v_ok, v_err,
                                  'candy_mlb', NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'via', CASE WHEN session_user = 'cron_heavy' THEN 'pg_cron' ELSE 'manual:' || session_user END, 'mode', 'force', 'issue', '#141'));
END
$function$;

CREATE OR REPLACE FUNCTION public.resync_stuck_wmc_fmv(p_min_age interval DEFAULT interval '6 hours')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_coll    uuid;
  v_n       integer;
  v_total   integer := 0;
  v_detail  jsonb := '{}'::jsonb;
  v_ok      boolean := true;
  v_err     text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('resync_stuck_wmc_fmv')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  BEGIN
    FOR v_coll IN SELECT id FROM public.collections ORDER BY id LOOP
      WITH ed AS MATERIALIZED (
        SELECT e.collection_id, e.external_id, l.fmv_usd, l.confidence
          FROM public.edition_fmv_current l
          JOIN public.editions e ON e.id = l.edition_id
         WHERE e.collection_id = v_coll
           AND l.fmv_usd IS NOT NULL
           AND l.computed_at < now() - p_min_age
           AND (SELECT f.fmv_usd FROM public.fmv_snapshots f
                 WHERE f.edition_id = l.edition_id AND f.fmv_usd IS NOT NULL
                 ORDER BY f.computed_at DESC LIMIT 1) = l.fmv_usd
      ),
      upd AS (
        UPDATE public.wallet_moments_cache w
           SET fmv_usd = ed.fmv_usd,
               fmv_confidence = ed.confidence
          FROM ed
         WHERE w.collection_id = ed.collection_id
           AND w.edition_key   = ed.external_id
           AND (w.fmv_usd IS DISTINCT FROM ed.fmv_usd OR w.fmv_confidence IS DISTINCT FROM ed.confidence)
        RETURNING 1
      )
      SELECT count(*)::int INTO v_n FROM upd;
      v_total := v_total + v_n;
      IF v_n > 0 THEN v_detail := v_detail || jsonb_build_object(v_coll::text, v_n); END IF;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- The whole run rolls back to the block start, so nothing is known to be written.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
    v_total := NULL;
  END;
  PERFORM public.log_pipeline_run('wmc-fmv-stuck-resync', v_started, NULL, v_total, NULL, v_ok, v_err,
                                  NULL, NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'via', CASE WHEN session_user = 'cron_heavy' THEN 'pg_cron' ELSE 'manual:' || session_user END, 'min_age', p_min_age::text,
                                                     'fixed_by_collection', v_detail));
  RETURN jsonb_build_object('fixed', v_total, 'ok', v_ok, 'error', v_err, 'by_collection', v_detail);
END
$function$;
