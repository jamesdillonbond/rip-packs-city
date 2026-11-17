-- 2026-09-26 (PT) — which packs Dapper MINTED straight into a wallet, read from
-- the chain, so a pack that never passed through a marketplace is known to have
-- come from Dapper however late it arrived.
--
-- WHY. Trevor's pack history priced a pack with no buy row at its drop's retail
-- only when it arrived inside the drop's sale window (start_time - 1 day .. +30
-- days; migration 20260926190300). 227 of his sealed Top Shot packs and 7 rips
-- missed that window by a median of ~2 months, and 215 of them share ONE
-- arrival: 2026-04-24 04:15 AM PT. Flow tx 849c43fa…13a2 (payer and authorizer
-- 0xb6f2481eba4df97b, Dapper's PDS account) runs `mintPackNFT(distId, …,
-- recvCap)` for a list of distributions -- Anthology Quick Rip (2024-06), Fast
-- Break rewards, 2026 Trade Ticket packs -- straight into 0xbd94…: 306 events,
-- PackNFT.Minted + PackNFT.Deposit(to: 0xbd94…) per pack. Those NFTs did not exist
-- before that transaction, so no marketplace sale can precede them: they are
-- packs the account already held at Dapper (custodial) turned into NFTs. Dapper's
-- index names the arrival (pack_nft_identity.acquired_at) but not HOW it arrived.
--
-- WHAT. A self-contained lane (touches no other lane's tables):
--   pack_nft_mints     one row per PackNFT seen in a PackNFT.Minted event:
--                      (collection, pack id, distId, block time/height, tx)
--   pack_mint_probes   one row per (collection, arrival instant) taken from
--                      pack_nft_identity.acquired_at on or after the Flow spork
--                      floor (height 137,390,146, 2025-12-29 -- the access nodes
--                      serve nothing older). A probe reads the 250-block window
--                      around that instant for PackNFT.Minted.
--   flow_height_estimate(ts)  block height at an instant, interpolated between
--                      the nearest topshot_pack_sales_history rows (dense, every
--                      row carries block_height + block_time).
--   run_pack_mint_probe_lane()  collect landed probes (a window that misses its
--                      instant re-aims from the block times it DID read, up to
--                      4 attempts), enqueue new instants (hourly), dispatch up
--                      to 40 probes (saved wallets' instants first).
-- pg_cron rpc-pack-mint-probe-lane at 3-58/5 (off the 0/1/20/21/40/41 ban).
--
-- A pack is "minted to the wallet" when its mint's block time equals (within
-- 2 s) the instant Dapper's index says the wallet acquired it. The readers use
-- that in the next migrations; this lane only records what the chain says.
-- Before the spork floor nothing is claimed either way.
--
-- Revert:
--   SELECT cron.unschedule('rpc-pack-mint-probe-lane');
--   DROP FUNCTION public.run_pack_mint_probe_lane();
--   DROP FUNCTION public.flow_height_estimate(timestamptz);
--   DROP TABLE public.pack_mint_probes, public.pack_nft_mints;
--   (revert 20260926200100 / 200200 / 200300 first -- they read pack_nft_mints.)

CREATE TABLE IF NOT EXISTS public.pack_nft_mints (
  collection_id  uuid        NOT NULL REFERENCES public.collections(id),
  pack_nft_id    text        NOT NULL,
  dist_id        text,
  minted_at      timestamptz NOT NULL,
  block_height   bigint      NOT NULL,
  tx_id          text        NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, pack_nft_id)
);
COMMENT ON TABLE public.pack_nft_mints IS
  'PackNFT.Minted events read from Flow (block time/height/tx per pack). Written by run_pack_mint_probe_lane(). A pack minted at the instant a wallet acquired it (pack_nft_identity.acquired_at, within 2 s) was minted INTO that wallet by Dapper: it never passed through a marketplace.';

CREATE TABLE IF NOT EXISTS public.pack_mint_probes (
  collection_id  uuid        NOT NULL REFERENCES public.collections(id),
  probe_at       timestamptz NOT NULL,
  priority       int         NOT NULL DEFAULT 0,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  start_height   bigint,
  request_id     bigint,
  attempts       int         NOT NULL DEFAULT 0,
  dispatched_at  timestamptz,
  finished_at    timestamptz,
  n_minted       int,
  n_at_instant   int,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, probe_at)
);
CREATE INDEX IF NOT EXISTS idx_pack_mint_probes_pending
  ON public.pack_mint_probes (priority DESC, probe_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pack_mint_probes_in_flight
  ON public.pack_mint_probes (dispatched_at) WHERE status = 'in_flight';
COMMENT ON COLUMN public.pack_mint_probes.n_at_instant IS
  'PackNFT.Minted events whose block time equals probe_at (within 2 s). 0 on a done probe = the packs that arrived then were transferred or bought, not minted in.';

ALTER TABLE public.pack_nft_mints   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pack_mint_probes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_nft_mints   FROM anon, authenticated;
REVOKE ALL ON public.pack_mint_probes FROM anon, authenticated;


-- ── flow_height_estimate ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.flow_height_estimate(p_at timestamptz)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  -- Interpolate between the nearest marketplace sales on either side of p_at
  -- (each carries its block height and time); extrapolate at ~1.19 blocks/s
  -- from one side when only one exists. NULL when there is no anchor at all.
  WITH a AS (
    SELECT block_height AS h, block_time AS t FROM public.topshot_pack_sales_history
     WHERE block_time <= p_at AND block_height IS NOT NULL
     ORDER BY block_time DESC LIMIT 1
  ), b AS (
    SELECT block_height AS h, block_time AS t FROM public.topshot_pack_sales_history
     WHERE block_time >= p_at AND block_height IS NOT NULL
     ORDER BY block_time LIMIT 1
  )
  SELECT CASE
           WHEN a.h IS NOT NULL AND b.h IS NOT NULL AND b.t > a.t
             THEN a.h + round((b.h - a.h) * extract(epoch FROM p_at - a.t) / extract(epoch FROM b.t - a.t))::bigint
           WHEN a.h IS NOT NULL THEN a.h + round(extract(epoch FROM p_at - a.t) * 1.19)::bigint
           WHEN b.h IS NOT NULL THEN b.h - round(extract(epoch FROM b.t - p_at) * 1.19)::bigint
         END
  FROM (SELECT 1) one LEFT JOIN a ON true LEFT JOIN b ON true
$function$;


-- ── run_pack_mint_probe_lane ────────────────────────────────────────────────
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
      'https://rest-mainnet.onflow.org/v1/events?type='
        || CASE r.collection_id WHEN v_ts THEN 'A.0b2a3299cc857e29' ELSE 'A.e4cf4bdc1751c65d' END
        || '.PackNFT.Minted&start_height=' || v_start || '&end_height=' || (v_start + 249)
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

-- Service-side only: pg_cron (postgres).
REVOKE ALL ON FUNCTION public.flow_height_estimate(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_pack_mint_probe_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_height_estimate(timestamptz) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.run_pack_mint_probe_lane() TO postgres, service_role;

SELECT cron.schedule('rpc-pack-mint-probe-lane', '3-58/5 * * * *', 'SELECT public.run_pack_mint_probe_lane();');
