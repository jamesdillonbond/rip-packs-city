-- audit_20261002_username_lane_403s_are_attributed_instead_of_filed_as_an_unknown_critical
--
-- 2026-10-02 ~8:00 AM PT (Claude Code, cloud, autonomous pass).
--
-- WHAT PAGED. get_pipeline_alerts() carried `pg_net_http_403 · CRITICAL · 1 call … NOT
-- attributable …` at 7:21 AM PT, body a Cloudflare "Just a moment" challenge. The 09-30
-- metrics-latest.json carries the identical row ("known unattributable arm"). It is not
-- unattributable: net._http_response id 1117566 landed 05:38:22 PT, 22 s after the :38 tick
-- of rpc-member-wallet-usernames-atlas dispatched its one Atlas SearchUserProfiles POST,
-- and that lane's own 05:48 run logged `atlas status 403` (responses_failed 1). The lane
-- has logged 11 such 403s in 48 h — each one a CRITICAL row on the alerts board for the
-- 2 h window that follows it, every one a Cloudflare base-rate challenge of the kind the
-- Atlas market/editions arms already file as `info`.
--
-- WHY THE ARM COULD NOT SEE IT. check_edge_fn_http_failures() attributes a 4xx by joining
-- net._http_response.id to the request tables the dispatchers persist. The username lane
-- (20260930043000/050000) DID persist its request id — and then DELETED the row the moment
-- it collected the response, so by the time the arm ran there was nothing to join.
--
-- WHAT THIS DOES.
--   1. member_wallet_username_requests gains drained_at / status_code / error. The lane
--      MARKS a collected request instead of deleting it (status + first failure note), and
--      prunes rows 24 h after they drained (dispatched, for the never-answered). Dispatch
--      gating is unchanged: `v_inflight` counts rows with NO response that are < 1 h old,
--      exactly the set it counted before. Hits/misses/wallet re-pick are unchanged.
--   2. check_edge_fn_http_failures() learns the lane ('usernames', ord 8): `info` while a 200
--      has landed on it in the last 6 h, `high` otherwise, with the window's dispatch count
--      as the denominator. Spliced into the live body on four unique anchors, each asserted
--      unique and refused if already patched (the 20260919021500 technique).
--
-- CONTROL. After the apply the live body references member_wallet_username_requests and the
-- 'usernames' branch; the 05:38 response (id 1117566) is outside any live window by now, so
-- the attribution is proven on the NEXT challenge: the board shows
-- `atlas-usernames-upstream-403 · info` and no `pg_net_http_403` row for it.
--
-- REVERT: re-apply resolve_member_wallet_usernames_via_atlas from 20260930050000 (it ignores
-- the new columns); check_edge_fn_http_failures — re-apply its pre-patch body
-- (pg_get_functiondef read before this apply, or re-run 20260919021500's splice over the
-- 20260911041900 body); then ALTER TABLE public.member_wallet_username_requests
-- DROP COLUMN drained_at, DROP COLUMN status_code, DROP COLUMN error.
--
-- anon-exec: unchanged (resolve_member_wallet_usernames_via_atlas) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege('anon', …, 'EXECUTE') = false live 2026-10-02, re-asserted below.
-- anon-exec: unchanged (check_edge_fn_http_failures) — CREATE OR REPLACE of an existing fn via the splice; ACL preserved (REVOKE/GRANT restated below as in 20260919021500), verified anon = false live 2026-10-02.

ALTER TABLE public.member_wallet_username_requests
  ADD COLUMN IF NOT EXISTS drained_at  timestamptz,
  ADD COLUMN IF NOT EXISTS status_code integer,
  ADD COLUMN IF NOT EXISTS error       text;

COMMENT ON TABLE public.member_wallet_username_requests IS
  'Every Atlas SearchUserProfiles request the member-username lane dispatched (request_id = net._http_response.id). Rows are MARKED drained (drained_at, status_code, error) on collect and pruned 24 h later, so check_edge_fn_http_failures() can attribute a 4xx to this lane (2026-10-02). In-flight = drained_at IS NULL.';

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
  v_note      text;
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
    -- ── 0. PRUNE drained request rows after 24 h (kept that long so the 4xx arm can
    --       attribute a failed response to this lane; it reads a 2 h window) ──────
    DELETE FROM public.member_wallet_username_requests
     WHERE coalesce(drained_at, dispatched_at) < now() - interval '24 hours';

    -- ── 1. COLLECT what earlier ticks dispatched ─────────────────────────────
    FOR r IN SELECT * FROM public.member_wallet_username_requests WHERE drained_at IS NULL ORDER BY dispatched_at LOOP
      SELECT status_code, timed_out, content, error_msg INTO v_resp
        FROM net._http_response WHERE id = r.request_id;

      IF NOT FOUND THEN
        IF r.dispatched_at < now() - interval '1 hour' THEN
          -- pg_net never recorded it; mark it drained so its wallets are re-picked.
          UPDATE public.member_wallet_username_requests
             SET drained_at = now(), error = 'lost: pg_net recorded no response within 1 h'
           WHERE request_id = r.request_id;
          v_lost := v_lost + 1;
        ELSE
          v_inflight := v_inflight + 1;
        END IF;
        CONTINUE;
      END IF;

      IF v_resp.status_code IS DISTINCT FROM 200 OR coalesce(v_resp.timed_out, false) THEN
        v_failed := v_failed + 1;
        v_note := 'atlas status ' || coalesce(v_resp.status_code::text, 'none')
          || CASE WHEN v_resp.timed_out THEN ' (timed out)' ELSE '' END
          || coalesce(': ' || left(v_resp.error_msg, 120), '');
        v_fail_note := coalesce(v_fail_note, v_note);
        -- kept, not deleted: check_edge_fn_http_failures() joins request_id to attribute
        -- the 4xx to THIS lane instead of filing it as an unknown critical
        UPDATE public.member_wallet_username_requests
           SET drained_at = now(), status_code = v_resp.status_code, error = left(v_note, 300)
         WHERE request_id = r.request_id;
        CONTINUE;
      END IF;

      v_body := v_resp.content::jsonb;
      IF jsonb_typeof(v_body -> 'userProfiles') IS DISTINCT FROM 'array' THEN
        v_failed := v_failed + 1;
        v_fail_note := coalesce(v_fail_note, 'atlas 200 without a userProfiles array');
        UPDATE public.member_wallet_username_requests
           SET drained_at = now(), status_code = 200, error = 'atlas 200 without a userProfiles array'
         WHERE request_id = r.request_id;
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

      UPDATE public.member_wallet_username_requests
         SET drained_at = now(), status_code = 200
       WHERE request_id = r.request_id;
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

-- ── the 4xx arm learns this lane ─────────────────────────────────────────────
DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_join_anchor constant text := '      LEFT JOIN public.pack_nft_identity_requests pq ON pq.request_id = r.id';
  c_lane_anchor constant text := '             ELSE ''unknown''';
  c_ord_anchor  constant text := 'WHEN ''pack-identity'' THEN 7 ELSE 0 END AS ord,';
  c_else_anchor constant text := '          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';
  c_branch constant text := $b$      WHEN 'usernames' THEN
        jsonb_build_object(
          'severity', CASE WHEN (SELECT max(drained_at) FROM public.member_wallet_username_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.member_wallet_username_requests WHERE status_code = 200) < now() - interval '6 hours'
                           THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-usernames-upstream-' || g.status_code::text,
          'detail',   g.n || ' of '
                      || (SELECT count(*) FROM public.member_wallet_username_requests WHERE dispatched_at > now() - p_window)
                      || ' Atlas SearchUserProfiles call(s) from the member-username lane returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'member_wallet_username_requests.request_id, which resolve_member_wallet_usernames_via_atlas() '
                      || 'records at dispatch time and keeps for 24 h with the status it collected (2026-10-02; before that '
                      || 'the row was deleted on collect and every challenge here filed as pg_net_http_403 critical). '
                      || 'NOTHING IS LOST: a failed response writes no username and no miss, so the same wallets are '
                      || 're-picked on the next tick; Cloudflare challenges this egress at the same ~5-15% base rate as '
                      || 'the Atlas market feed. THIS ROW ESCALATES TO high when no 200 has landed on this lane in 6 h. '
                      || 'Last 200: ' || COALESCE(to_char((SELECT max(drained_at) FROM public.member_wallet_username_requests WHERE status_code = 200) AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
$b$;
BEGIN
  -- pg_get_function_arguments, NOT the identity form: the live signature carries a DEFAULT, and
  -- CREATE OR REPLACE without it fails with 42P13 'cannot remove parameter defaults' (seen on
  -- the first apply of this file, 2026-10-02).
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF position('member_wallet_username_requests' in v_src) > 0 THEN
    RAISE EXCEPTION 'body already references member_wallet_username_requests -- refusing to double-patch';
  END IF;
  IF position('$f$' in v_src) > 0 THEN
    RAISE EXCEPTION 'body contains the dollar-quote tag this migration uses';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_join_anchor, ''))) / length(c_join_anchor) <> 1 THEN
    RAISE EXCEPTION 'join anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_lane_anchor, ''))) / length(c_lane_anchor) <> 1 THEN
    RAISE EXCEPTION 'lane anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_ord_anchor, ''))) / length(c_ord_anchor) <> 1 THEN
    RAISE EXCEPTION 'ord anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_else_anchor, ''))) / length(c_else_anchor) <> 1 THEN
    RAISE EXCEPTION 'else anchor is not unique';
  END IF;

  v_new := replace(v_src, c_join_anchor,
                   c_join_anchor || E'\n      LEFT JOIN public.member_wallet_username_requests un ON un.request_id = r.id');
  v_new := replace(v_new, c_lane_anchor,
                   'WHEN (SELECT can_attribute FROM bounds) AND un.request_id IS NOT NULL THEN ''usernames''' ||
                   E'\n' || c_lane_anchor);
  v_new := replace(v_new, c_ord_anchor,
                   'WHEN ''pack-identity'' THEN 7 WHEN ''usernames'' THEN 8 ELSE 0 END AS ord,');
  v_new := replace(v_new, '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor,
                   c_branch || '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor);

  IF position('member_wallet_username_requests un' in v_new) = 0
     OR position('''usernames''' in v_new) = 0
     OR position('atlas-usernames-upstream-' in v_new) = 0 THEN
    RAISE EXCEPTION 'transform produced no usernames reference';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(%s) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp, net AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO postgres, service_role;

DO $mig$
DECLARE v jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.resolve_member_wallet_usernames_via_atlas(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_member_wallet_usernames_via_atlas(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked on resolve_member_wallet_usernames_via_atlas';
  END IF;
  IF has_function_privilege('anon', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon EXECUTE leaked on check_edge_fn_http_failures';
  END IF;
  -- the arm still runs, and still classifies the three lanes it already knew
  v := public.check_edge_fn_http_failures(interval '2 hours');
  IF v IS NULL THEN RAISE EXCEPTION 'check_edge_fn_http_failures returned NULL'; END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'member_wallet_username_requests'
         AND column_name IN ('drained_at', 'status_code', 'error')) <> 3 THEN
    RAISE EXCEPTION 'columns missing on member_wallet_username_requests';
  END IF;
END
$mig$;
