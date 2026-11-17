-- audit_20261003_atlas_editions_dispatch_retries_a_failed_set_after_5_minutes
--
-- WHY. The 8:04 AM PT daytime monitor (inbox 2026-10-03T1504Z) saw
-- `atlas-editions-upstream-403` escalate to HIGH: 1 of 282 sets had not completed a walk in 6 h.
-- Measured: the Cloudflare 403 rate was a steady 14–20 % every hour overnight (not escalating), and
-- set 227 had simply lost four draws in a row. The ORDER BY made that likely: a set that fails on
-- page 0 keeps next_offset = 0, so it went to the BACK of the rotation (last_dispatched_at ASC)
-- and waited a full ~82-min cycle per retry. At p ≈ 0.17 per page that predicts ~0.24 stalled
-- sets at any moment — i.e. this HIGH fires by chance, forever, unless the retry spacing changes.
-- (A set failing MID-walk, next_offset > 0, was already retried first — within minutes.)
--
-- WHAT. One added ORDER BY key: a set whose LAST attempt did not complete
-- (last_completed_at NULL or older than last_dispatched_at — atlas_editions_drain() stamps
-- last_completed_at = now() only when the final page drains) and whose last dispatch is > 5 min
-- old is retried ahead of the healthy rotation. Calls per tick are still capped by p_calls, so
-- Cloudflare sees the SAME request rate; only the order changes, and the 5-min floor keeps a
-- burst from re-hitting the same set every tick. Checked first: 0 sets fail with a non-403
-- error (no permanent failure to loop on); 57 currently had a failed last attempt.
--
-- Body otherwise byte-identical to the live function (prosrc compared against
-- 20260904063544 before writing).
--
-- anon-exec: unchanged (atlas_editions_dispatch) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false, cron_heavy=true.
--
-- REVERT: re-apply the atlas_editions_dispatch body from
--   20260904063544_audit_20260904_atlas_edition_refresh_via_pg_net_replaces_the_dead_topshot_graphql_behind_badge_editions.sql
--   (ORDER BY (s.next_offset > 0) DESC, s.last_dispatched_at ASC NULLS FIRST, s.set_id_onchain).

CREATE OR REPLACE FUNCTION public.atlas_editions_dispatch(p_calls integer DEFAULT 8)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  r record;
  v_req bigint;
  v_n integer := 0;
BEGIN
  -- Seed: every Top Shot set the catalog knows.
  INSERT INTO public.atlas_set_refresh_state (set_id_onchain)
  SELECT DISTINCT e.set_id_onchain FROM public.editions e
   WHERE e.collection_id = v_ts AND e.set_id_onchain IS NOT NULL
  ON CONFLICT (set_id_onchain) DO NOTHING;

  FOR r IN
    SELECT s.set_id_onchain, s.next_offset
      FROM public.atlas_set_refresh_state s
     WHERE NOT EXISTS (SELECT 1 FROM public.atlas_edition_requests q
                        WHERE q.set_id_onchain = s.set_id_onchain AND q.drained_at IS NULL
                          AND q.dispatched_at > now() - interval '10 minutes')
     ORDER BY (s.next_offset > 0) DESC,
              -- 2026-10-03: a set whose last attempt failed retries after 5 min, not a full cycle.
              (s.last_dispatched_at IS NOT NULL
                 AND (s.last_completed_at IS NULL OR s.last_completed_at < s.last_dispatched_at)
                 AND s.last_dispatched_at < now() - interval '5 minutes') DESC,
              s.last_dispatched_at ASC NULLS FIRST, s.set_id_onchain
     LIMIT GREATEST(p_calls, 0)
  LOOP
    v_req := net.http_post(
      url     := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions',
      body    := jsonb_build_object('product', 'nba', 'setId', jsonb_build_array(r.set_id_onchain::text),
                                    'limit', '100', 'offset', r.next_offset::text),
      headers := '{"content-type":"application/json","connect-protocol-version":"1","origin":"https://nbatopshot.com","referer":"https://nbatopshot.com/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"}'::jsonb,
      timeout_milliseconds := 20000);
    INSERT INTO public.atlas_edition_requests (request_id, set_id_onchain, offset_at) VALUES (v_req, r.set_id_onchain, r.next_offset);
    UPDATE public.atlas_set_refresh_state SET last_dispatched_at = now() WHERE set_id_onchain = r.set_id_onchain;
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END
$function$;
