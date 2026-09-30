-- 2026-09-29 (PT): the member-username lane also drains the SITE-WIDE queue, and never asks Atlas for
-- more than 25 wallets.
--
-- 1. A LIMIT THE FIRST VERSION DID NOT KNOW. A probe of 50 addresses returned
--    `400 invalid_argument: too many identifiers: max 25`. 20260930043000 asked for up to 50, so any
--    tick with >25 member wallets waiting would have failed, re-picked the same wallets and failed
--    again, forever. The batch is now clamped to 25 inside the function (whatever the caller passes)
--    and the pg_cron command passes 25. A 25-address probe returned 200 with 22 profiles.
--
-- 2. THE STOPPED RESOLVER'S QUEUE. `wallet_usernames_unresolved()` (wallets seen in the last 2 days of
--    sales / pack purchases, plus misses older than 14 days) had no consumer since 2026-08-30, when
--    /api/cron/resolve-wallet-usernames' Top Shot GraphQL host died; it held 1,443 wallets tonight.
--    That route is NOT re-enabled (cron-and-schedulers.md: nothing visible here says whether its
--    schedule was removed on purpose). Instead, when no member wallet is waiting, this lane sends
--    that queue's first 25 to Atlas on the ticks at :08 and :38. Building the queue costs ~2.5 s /
--    ~27k buffers per call (measured), so 48 calls/day, the cadence the old resolver ran at.
--    ~1,200 wallets/day: the backlog clears in ~1-2 days, then it keeps up with new traders.
--    Still one Atlas request per tick (#65's burst rule). Hits and misses are written exactly as for
--    members; the run's `extra.leg` says which queue a request served.
--
-- Revert: re-apply the function from 20260930043000 and
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-member-wallet-usernames-atlas'),
--                         command => 'SELECT public.resolve_member_wallet_usernames_via_atlas(50)');

DROP FUNCTION IF EXISTS public.resolve_member_wallet_usernames_via_atlas(integer);

CREATE OR REPLACE FUNCTION public.resolve_member_wallet_usernames_via_atlas(p_batch integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_collected int := 0;
  v_resolved  int := 0;
  v_missed    int := 0;
  v_failed    int := 0;
  v_lost      int := 0;
  v_inflight  int := 0;
  v_cand      int := 0;
  v_dispatched int := 0;
  v_fail_note text;
  v_err       text;
  r           record;
  v_resp      record;
  v_body      jsonb;
  v_wallets   text[];
  v_req       bigint;
  v_n         int;
  v_batch     int := least(greatest(coalesce(p_batch, 25), 1), 25);
  v_leg       text;
  v_general_due boolean := extract(minute from now()) < 10 OR extract(minute from now()) BETWEEN 30 AND 39;
BEGIN
  PERFORM set_config('statement_timeout', '60000', true);

  IF NOT pg_try_advisory_xact_lock(hashtext('resolve_member_wallet_usernames_via_atlas')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    -- ── 1. COLLECT what earlier ticks dispatched ─────────────────────────────
    FOR r IN SELECT * FROM public.member_wallet_username_requests ORDER BY dispatched_at LOOP
      SELECT status_code, timed_out, content, error_msg INTO v_resp
        FROM net._http_response WHERE id = r.request_id;

      IF NOT FOUND THEN
        IF r.dispatched_at < now() - interval '1 hour' THEN
          -- pg_net never recorded it; drop the marker so its wallets are re-picked.
          DELETE FROM public.member_wallet_username_requests WHERE request_id = r.request_id;
          v_lost := v_lost + 1;
        ELSE
          v_inflight := v_inflight + 1;
        END IF;
        CONTINUE;
      END IF;

      IF v_resp.status_code IS DISTINCT FROM 200 OR coalesce(v_resp.timed_out, false) THEN
        v_failed := v_failed + 1;
        v_fail_note := coalesce(v_fail_note,
          'atlas status ' || coalesce(v_resp.status_code::text, 'none')
          || CASE WHEN v_resp.timed_out THEN ' (timed out)' ELSE '' END
          || coalesce(': ' || left(v_resp.error_msg, 120), ''));
        DELETE FROM public.member_wallet_username_requests WHERE request_id = r.request_id;
        CONTINUE;
      END IF;

      v_body := v_resp.content::jsonb;
      IF jsonb_typeof(v_body -> 'userProfiles') IS DISTINCT FROM 'array' THEN
        v_failed := v_failed + 1;
        v_fail_note := coalesce(v_fail_note, 'atlas 200 without a userProfiles array');
        DELETE FROM public.member_wallet_username_requests WHERE request_id = r.request_id;
        CONTINUE;
      END IF;

      -- Hits: only profiles whose echoed flowAddress is one we asked for.
      WITH hits AS (
        SELECT DISTINCT ON (lower(p ->> 'flowAddress')) lower(p ->> 'flowAddress') AS wallet, p ->> 'username' AS username
          FROM jsonb_array_elements(v_body -> 'userProfiles') p
         WHERE lower(p ->> 'flowAddress') = ANY (r.wallets)
           AND nullif(trim(p ->> 'username'), '') IS NOT NULL
      ), up AS (
        INSERT INTO public.wallet_usernames AS wu (wallet_addr, username, source, resolved_at, updated_at, last_attempted_at)
        SELECT wallet, username, 'atlas', now(), now(), now() FROM hits
        ON CONFLICT (wallet_addr) DO UPDATE
          SET username = EXCLUDED.username, source = 'atlas', resolved_at = now(),
              updated_at = now(), last_attempted_at = now()
        RETURNING 1
      )
      SELECT count(*) INTO v_n FROM up;
      v_resolved := v_resolved + v_n;

      -- Misses: asked for, not returned. Never overwrite a known username.
      WITH answered AS (
        SELECT lower(p ->> 'flowAddress') AS wallet FROM jsonb_array_elements(v_body -> 'userProfiles') p
      ), misses AS (
        SELECT w FROM unnest(r.wallets) w WHERE w NOT IN (SELECT wallet FROM answered WHERE wallet IS NOT NULL)
      ), up AS (
        INSERT INTO public.wallet_usernames AS wu (wallet_addr, username, source, resolved_at, updated_at, last_attempted_at)
        SELECT w, NULL, 'atlas_miss', NULL, now(), now() FROM misses
        ON CONFLICT (wallet_addr) DO UPDATE
          SET last_attempted_at = now(), updated_at = now(), source = 'atlas_miss'
          WHERE wu.username IS NULL
        RETURNING 1
      )
      SELECT count(*) INTO v_n FROM up;
      v_missed := v_missed + v_n;

      DELETE FROM public.member_wallet_username_requests WHERE request_id = r.request_id;
      v_collected := v_collected + 1;
    END LOOP;

    -- ── 2. DISPATCH one request for members still without a username ─────────
    IF v_inflight = 0 THEN
      SELECT array_agg(wallet ORDER BY wallet), count(*) INTO v_wallets, v_cand
        FROM (
          SELECT m.wallet
            FROM (
              SELECT lower(wallet_addr) AS wallet FROM public.saved_wallets WHERE wallet_addr ~* '^0x[0-9a-f]{16}$'
              UNION
              SELECT lower(wallet_addr) FROM public.allow_list WHERE wallet_addr ~* '^0x[0-9a-f]{16}$'
            ) m
            LEFT JOIN public.wallet_usernames wu ON wu.wallet_addr = m.wallet
           WHERE wu.wallet_addr IS NULL
              OR (wu.username IS NULL AND (wu.last_attempted_at IS NULL OR wu.last_attempted_at < now() - interval '14 days'))
           ORDER BY m.wallet
           LIMIT v_batch
        ) c;
      IF v_cand > 0 THEN
        v_leg := 'members';
      ELSIF v_general_due THEN
        -- The site-wide queue the stopped GraphQL resolver used to drain (wallets seen in the last
        -- 2 days of sales / pack purchases, plus 14-day-old misses). Only twice an hour: building
        -- it costs ~2.5 s / ~27k buffers (measured 2026-09-29), the same cadence that resolver ran at.
        v_wallets := public.wallet_usernames_unresolved(v_batch);
        v_cand := coalesce(cardinality(v_wallets), 0);
        IF v_cand > 0 THEN v_leg := 'site_wide'; END IF;
      END IF;

      IF v_cand > 0 THEN
        v_req := net.http_post(
          url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.ProfileService/SearchUserProfiles',
          body := jsonb_build_object('product', 'nba', 'flow_addresses', to_jsonb(v_wallets)),
          headers := public.atlas_market_headers('nba'),
          timeout_milliseconds := 15000);
        INSERT INTO public.member_wallet_username_requests (request_id, wallets) VALUES (v_req, v_wallets);
        v_dispatched := v_cand;
      END IF;
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'member-wallet-usernames-atlas', v_started, v_cand, v_resolved + v_missed, 0,
    v_err IS NULL AND v_failed = 0, coalesce(v_err, v_fail_note), 'nba_top_shot', NULL, NULL,
    jsonb_build_object('leg', v_leg, 'responses_collected', v_collected, 'usernames_written', v_resolved,
                       'misses_written', v_missed, 'responses_failed', v_failed,
                       'first_failure', v_fail_note, 'requests_lost', v_lost,
                       'requests_inflight', v_inflight, 'wallets_dispatched', v_dispatched,
                       'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('leg', v_leg, 'responses_collected', v_collected, 'usernames_written', v_resolved,
                            'misses_written', v_missed, 'responses_failed', v_failed,
                            'first_failure', v_fail_note, 'requests_lost', v_lost,
                            'requests_inflight', v_inflight, 'wallets_dispatched', v_dispatched,
                            'error', v_err);
END
$function$;

REVOKE ALL ON FUNCTION public.resolve_member_wallet_usernames_via_atlas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_member_wallet_usernames_via_atlas(integer) TO service_role;

SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-member-wallet-usernames-atlas'),
  command => 'SELECT public.resolve_member_wallet_usernames_via_atlas(25)');
