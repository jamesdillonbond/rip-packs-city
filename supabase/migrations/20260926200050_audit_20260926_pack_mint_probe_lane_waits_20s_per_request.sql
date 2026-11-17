-- 2026-09-26 (PT) — run_pack_mint_probe_lane: a 20 s request timeout.
--
-- The lane's first production runs (applied 10:53 AM PT) failed 21 of 80 probes
-- with "Timeout of 5000 ms reached ... DNS time: 5026 ms" -- pg_net's default
-- 5 s timeout spent entirely on DNS. The failed probes retry (up to 4
-- attempts) and the run already reports ok=false; this gives each request the
-- same 20 s budget the other pg_net lanes use. Nothing else changes.
-- anon-exec: unchanged (run_pack_mint_probe_lane) — CREATE OR REPLACE of an existing fn; ACL preserved (REVOKE FROM PUBLIC, anon, authenticated in 20260926200000).
--
-- Revert: re-apply the body from
--   supabase/migrations/20260926200000_audit_20260926_pack_nft_mints_name_packs_dapper_minted_straight_into_a_wallet.sql
-- and repoint its pin.

CREATE OR REPLACE FUNCTION public.run_pack_mint_probe_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_floor     constant bigint := 137390146;            -- Flow spork root: nothing older is served
  v_floor_at  constant timestamptz := '2025-12-29 00:00:00+00';
  v_ts uuid; v_ad uuid;
  r record;
  v_body jsonb;
  v_t0 timestamptz; v_t1 timestamptz; v_h0 bigint; v_h1 bigint;
  v_n int; v_at int; v_inst int;
  v_start bigint; v_req bigint;
  v_collected int := 0; v_done int := 0; v_reaimed int := 0; v_failed int := 0; v_expired int := 0;
  v_mints_new int := 0; v_enqueued int := 0; v_dispatched int := 0; v_below_floor int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pack_mint_probe_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  -- (1) Collect every landed probe.
  FOR r IN
    SELECT p.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
    FROM public.pack_mint_probes p
    LEFT JOIN net._http_response h ON h.id = p.request_id
    WHERE p.status = 'in_flight'
    ORDER BY p.dispatched_at
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.pack_mint_probes
           SET status = CASE WHEN attempts + 1 >= 4 THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, last_error = 'no_response',
               finished_at = CASE WHEN attempts + 1 >= 4 THEN now() END
         WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;

    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb')
                   THEN r.h_content::jsonb END;
    IF v_body IS NULL OR jsonb_typeof(v_body) IS DISTINCT FROM 'array' OR jsonb_array_length(v_body) = 0 THEN
      v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 200);
      UPDATE public.pack_mint_probes
         SET status = CASE WHEN attempts + 1 >= 4 THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1, last_error = v_last_error,
             finished_at = CASE WHEN attempts + 1 >= 4 THEN now() END
       WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
      v_failed := v_failed + 1;
      CONTINUE;
    END IF;

    SELECT min((b->>'block_timestamp')::timestamptz), max((b->>'block_timestamp')::timestamptz),
           min((b->>'block_height')::bigint), max((b->>'block_height')::bigint)
      INTO v_t0, v_t1, v_h0, v_h1
      FROM jsonb_array_elements(v_body) b;

    -- The window read blocks that do not contain the instant: re-aim from the
    -- block times it DID read (1.25 blocks/s, a margin past the gap) and retry.
    IF r.probe_at < v_t0 - interval '1 second' OR r.probe_at > v_t1 + interval '1 second' THEN
      v_start := CASE WHEN r.probe_at < v_t0
                      THEN v_h0 - ceil(extract(epoch FROM v_t0 - r.probe_at) * 1.25)::bigint - 125
                      ELSE v_h1 + ceil(extract(epoch FROM r.probe_at - v_t1) * 1.25)::bigint - 125 END;
      UPDATE public.pack_mint_probes
         SET status = CASE WHEN attempts + 1 >= 4 THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1, start_height = v_start,
             last_error = 'window ' || v_t0 || ' .. ' || v_t1 || ' missed the instant',
             finished_at = CASE WHEN attempts + 1 >= 4 THEN now() END
       WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
      v_reaimed := v_reaimed + 1;
      CONTINUE;
    END IF;

    WITH ev AS (
      SELECT (b->>'block_height')::bigint AS bh, (b->>'block_timestamp')::timestamptz AS bt,
             e->>'transaction_id' AS tx,
             convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb AS p
      FROM jsonb_array_elements(v_body) b
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e
    ), f AS (
      SELECT bh, bt, tx,
             (SELECT x->'value'->>'value' FROM jsonb_array_elements(p->'value'->'fields') x WHERE x->>'name' = 'id') AS pack_id,
             (SELECT x->'value'->>'value' FROM jsonb_array_elements(p->'value'->'fields') x WHERE x->>'name' = 'distId') AS dist_id
      FROM ev
    ), ins AS (
      INSERT INTO public.pack_nft_mints (collection_id, pack_nft_id, dist_id, minted_at, block_height, tx_id)
      SELECT r.collection_id, pack_id, dist_id, bt, bh, tx FROM f WHERE pack_id IS NOT NULL
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins),
           (SELECT count(*) FROM f WHERE pack_id IS NOT NULL),
           (SELECT count(*) FROM f WHERE pack_id IS NOT NULL AND abs(extract(epoch FROM bt - r.probe_at)) <= 2)
      INTO v_n, v_at, v_inst;
    v_mints_new := v_mints_new + v_n;

    UPDATE public.pack_mint_probes
       SET status = 'done', finished_at = now(), n_minted = v_at, n_at_instant = v_inst, last_error = NULL
     WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
    v_done := v_done + 1;
  END LOOP;

  -- (2) Enqueue new arrival instants (hourly: a full read of the index).
  -- Saved wallets' instants first.
  IF extract(minute FROM now()) < 5 OR NOT EXISTS (SELECT 1 FROM public.pack_mint_probes) THEN
    WITH ins AS (
      INSERT INTO public.pack_mint_probes (collection_id, probe_at, priority)
      SELECT i.collection_id, i.acquired_at,
             max(CASE WHEN EXISTS (SELECT 1 FROM public.saved_wallets s WHERE lower(s.wallet_addr) = i.owner_address) THEN 1 ELSE 0 END)
      FROM public.pack_nft_identity i
      WHERE i.acquired_at >= v_floor_at
        AND i.collection_id IN (v_ts, v_ad)
      GROUP BY i.collection_id, i.acquired_at
      ON CONFLICT (collection_id, probe_at) DO UPDATE
        SET priority = EXCLUDED.priority
        WHERE public.pack_mint_probes.priority < EXCLUDED.priority
      RETURNING (xmax = 0) AS inserted
    )
    SELECT count(*) FILTER (WHERE inserted) INTO v_enqueued FROM ins;
  END IF;

  -- (3) Dispatch up to 40 pending probes.
  FOR r IN
    SELECT * FROM public.pack_mint_probes
    WHERE status = 'pending'
    ORDER BY priority DESC, probe_at DESC
    LIMIT 40
  LOOP
    v_start := coalesce(r.start_height, public.flow_height_estimate(r.probe_at) - 125);
    IF v_start IS NULL OR v_start < v_floor THEN
      UPDATE public.pack_mint_probes
         SET status = 'failed', finished_at = now(),
             last_error = CASE WHEN v_start IS NULL THEN 'no height anchor' ELSE 'below the Flow spork floor' END
       WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
      v_below_floor := v_below_floor + 1;
      CONTINUE;
    END IF;
    SELECT net.http_get(
      url := 'https://rest-mainnet.onflow.org/v1/events?type='
        || CASE r.collection_id WHEN v_ts THEN 'A.0b2a3299cc857e29' ELSE 'A.e4cf4bdc1751c65d' END
        || '.PackNFT.Minted&start_height=' || v_start || '&end_height=' || (v_start + 249),
      timeout_milliseconds := 20000
    ) INTO v_req;
    UPDATE public.pack_mint_probes
       SET status = 'in_flight', request_id = v_req, start_height = v_start, dispatched_at = now()
     WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pack-mint-probes', v_started,
    v_collected, v_mints_new, 0,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('probes_done', v_done, 'probes_reaimed', v_reaimed, 'probes_failed', v_failed,
                       'probes_expired', v_expired, 'mints_new', v_mints_new, 'enqueued', v_enqueued,
                       'dispatched', v_dispatched, 'below_floor', v_below_floor)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'done', v_done,
                            'reaimed', v_reaimed, 'failed', v_failed, 'expired', v_expired,
                            'mints_new', v_mints_new, 'enqueued', v_enqueued,
                            'dispatched', v_dispatched, 'below_floor', v_below_floor,
                            'last_error', v_last_error);
END;
$function$;
