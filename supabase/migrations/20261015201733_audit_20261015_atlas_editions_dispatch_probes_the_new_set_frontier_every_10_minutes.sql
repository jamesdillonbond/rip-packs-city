-- audit_20261015_atlas_editions_dispatch_probes_the_new_set_frontier_every_10_minutes
--
-- WHY (2026-10-15, ahead of Top Shot Series 2026-27: opening-week Limited Release packs from
-- Oct 20, Rookie Debut drop Nov 11). A new Top Shot set reaches `editions` only after this lane
-- probes its set id (catalog_topshot_from_atlas seeds 10 ids past the highest set Atlas returned)
-- and the drain lands it in badge_editions. Measured live: 290 sets in rotation, 8 calls per 2-min
-- tick → a probe-ahead id is re-asked once per ~72–82 min cycle, so a set that goes on sale just
-- after its id was probed waits up to ~80 min for a catalog row. Recent drops: 09-28 (set 280)
-- was cataloged 40 min BEFORE its first sale; 09-23 (sets 275–279) 7.5–9.4 h after (the day the
-- Atlas catalog path itself was built); 08-26 sets 1.8–24.6 h after.
--
-- WHAT. One added ORDER BY key, after the mid-walk continuation: a FRONTIER set (set_id_onchain
-- above every set the catalog holds — i.e. the empty probe-ahead ids) whose last dispatch is
-- older than 9 min goes first. ~10 ids, so ≤10 of the 40 calls per 10 min; the request RATE to
-- Atlas is unchanged (p_calls still caps every tick), the existing rotation slows from ~80 to
-- ~105 min. Once a frontier id returns editions, the catalog fills it within 10 min and the
-- frontier moves past it on its own.
--
-- Base = live prosrc md5 d2d95e854af8c63d72bfacbf8cb7c6a7 (= 20261003151308 body, verified).
-- anon-exec: unchanged (atlas_editions_dispatch) — CREATE OR REPLACE of an existing fn; ACL preserved (postgres, service_role, cron_heavy EXECUTE).
--
-- REVERT: re-apply the body of 20261003151308_audit_20261003_atlas_editions_dispatch_retries_a_failed_set_after_5_minutes.sql.

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
  v_max_known integer;
BEGIN
  -- Seed: every Top Shot set the catalog knows.
  INSERT INTO public.atlas_set_refresh_state (set_id_onchain)
  SELECT DISTINCT e.set_id_onchain FROM public.editions e
   WHERE e.collection_id = v_ts AND e.set_id_onchain IS NOT NULL
  ON CONFLICT (set_id_onchain) DO NOTHING;

  -- 2026-10-15: the frontier — probe-ahead set ids beyond every set the catalog holds — is where a
  -- NEW Top Shot set first appears. It is re-probed every ~10 min instead of once per rotation.
  SELECT max(e.set_id_onchain) INTO v_max_known
    FROM public.editions e
   WHERE e.collection_id = v_ts AND e.set_id_onchain IS NOT NULL;

  FOR r IN
    SELECT s.set_id_onchain, s.next_offset
      FROM public.atlas_set_refresh_state s
     WHERE NOT EXISTS (SELECT 1 FROM public.atlas_edition_requests q
                        WHERE q.set_id_onchain = s.set_id_onchain AND q.drained_at IS NULL
                          AND q.dispatched_at > now() - interval '10 minutes')
     ORDER BY (s.next_offset > 0) DESC,
              (s.set_id_onchain > v_max_known
                 AND (s.last_dispatched_at IS NULL OR s.last_dispatched_at < now() - interval '9 minutes')) DESC,
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

