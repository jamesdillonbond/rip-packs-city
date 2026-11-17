-- 2026-09-29 (PT): members' Top Shot usernames come from Atlas, and `user_activity` shows them.
--
-- Trevor, on the first `user_activity` read: two signed-in users showed a shortened wallet
-- ("0x1062…42fc", "0x0d79…3cdc") where their Top Shot username belongs.
--
-- WHY THEY HAD NONE. `wallet_usernames` (the wallet -> Top Shot username cache) is fed by
-- `wallet_usernames_unresolved()` + /api/cron/resolve-wallet-usernames, whose candidates are
-- wallets seen in the last 2 days of SALES / PACK PURCHASES — a member who has not traded is never
-- a candidate — and that resolver has been STOPPED since 2026-08-30 (its Top Shot GraphQL host is
-- dead; cron-and-schedulers.md). Of 31 member Flow wallets, 1 had no row at all.
--
-- THE LOOKUP, measured before writing this: Atlas `ProfileService/SearchUserProfiles` accepts
-- `{product:'nba', flow_addresses:[…]}` and answers every address in ONE request — a single probe
-- for both wallets returned `AnythingIsPossible` (0x0d79d58c5fe83cdc) and `sdb`
-- (0x106252906d6542fc), each with its `flowAddress` echoed back, which this function checks.
--
-- SHAPE: two-phase over pg_net, like the other Atlas lanes (a response is only visible after the
-- dispatching transaction commits). Each tick (1) collects any request dispatched on an earlier
-- tick, then (2) dispatches ONE request for up to 50 member Flow wallets (saved_wallets ∪
-- allow_list) that have no username row, or a miss older than 14 days. Wallets Atlas answers are
-- written `source='atlas'`; wallets it does not return are negative-cached `source='atlas_miss'`
-- (never over a known username). A non-200 / timed-out response writes nothing, reports
-- ok=false with the status, and its wallets are re-picked next tick. One request per tick, every
-- 10 minutes (#65's burst rule: Atlas answers "Just a moment…" to bursts).
--
-- `user_activity.display_name` now prefers that Top Shot username, then the allow_list username,
-- then the saved-wallet label, then a shortened wallet, then the email's local part.
--
-- Revert:
--   SELECT cron.unschedule('rpc-member-wallet-usernames-atlas');
--   DROP FUNCTION IF EXISTS public.resolve_member_wallet_usernames_via_atlas();
--   DROP TABLE IF EXISTS public.member_wallet_username_requests;
--   then re-apply the user_activity view from 20260930041000.
--   (wallet_usernames rows written with source in ('atlas','atlas_miss') by this lane may stay.)

CREATE TABLE IF NOT EXISTS public.member_wallet_username_requests (
  request_id bigint PRIMARY KEY,
  wallets text[] NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_wallet_username_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_wallet_username_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.resolve_member_wallet_usernames_via_atlas(p_batch integer DEFAULT 50)
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
           LIMIT greatest(p_batch, 1)
        ) c;

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
    jsonb_build_object('responses_collected', v_collected, 'usernames_written', v_resolved,
                       'misses_written', v_missed, 'responses_failed', v_failed,
                       'first_failure', v_fail_note, 'requests_lost', v_lost,
                       'requests_inflight', v_inflight, 'wallets_dispatched', v_dispatched,
                       'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('responses_collected', v_collected, 'usernames_written', v_resolved,
                            'misses_written', v_missed, 'responses_failed', v_failed,
                            'first_failure', v_fail_note, 'requests_lost', v_lost,
                            'requests_inflight', v_inflight, 'wallets_dispatched', v_dispatched,
                            'error', v_err);
END
$function$;

REVOKE ALL ON FUNCTION public.resolve_member_wallet_usernames_via_atlas(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_member_wallet_usernames_via_atlas(integer) TO service_role;

SELECT cron.schedule('rpc-member-wallet-usernames-atlas', '8-58/10 * * * *',
  'SELECT public.resolve_member_wallet_usernames_via_atlas(50)');

CREATE OR REPLACE VIEW public.user_activity
WITH (security_invoker = on) AS
SELECT
  e.id,
  e.occurred_at,
  e.feature_name,
  e.metadata,
  e.user_id,
  (e.user_id IS NOT NULL) AS signed_in,
  CASE
    WHEN e.user_id IS NULL THEN NULL
    WHEN u.id IS NULL THEN '(deleted account)'
    ELSE coalesce(
      nullif(wun.username, ''),
      nullif(al.username, ''),
      nullif(sw.username, ''),
      CASE WHEN w.wallet IS NOT NULL THEN left(w.wallet, 6) || '…' || right(w.wallet, 4) END,
      split_part(u.email, '@', 1)
    )
  END AS display_name,
  u.email,
  w.wallet,
  (ia.user_id IS NOT NULL) AS is_internal,
  coalesce((e.metadata ->> 'automated')::boolean, false) AS is_automated,
  e.wallet_address AS legacy_key
FROM public.usage_events e
LEFT JOIN auth.users u ON u.id = e.user_id
LEFT JOIN LATERAL (
  SELECT a.username, a.wallet_addr
  FROM public.allow_list a
  WHERE u.email IS NOT NULL AND lower(a.email) = lower(u.email)
  ORDER BY a.created_at DESC NULLS LAST
  LIMIT 1
) al ON true
LEFT JOIN LATERAL (
  SELECT s.username, s.wallet_addr
  FROM public.saved_wallets s
  WHERE s.user_id = e.user_id
  ORDER BY (s.username IS NULL), s.pinned_at DESC NULLS LAST, s.wallet_addr
  LIMIT 1
) sw ON true
LEFT JOIN LATERAL (
  SELECT lower(coalesce(al.wallet_addr, sw.wallet_addr)) AS wallet
) w ON true
LEFT JOIN public.wallet_usernames wun ON wun.wallet_addr = w.wallet
LEFT JOIN public.internal_accounts ia ON ia.user_id = e.user_id;

REVOKE ALL ON public.user_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_activity TO service_role;
