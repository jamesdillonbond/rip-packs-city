-- 2026-09-29 (PT) — Disney Pinnacle pack OPENERS read from the open
-- transaction's Pinnacle.Deposit events on Flow's historical sporks.
--
-- WHY. pinnacle_pack_opens held 90,105 opens and 0 openers: Dapper's index
-- names the Pinnacle contract (the custodian) as every opened pack's owner, so
-- the ingest stores NULL (packs.md dead end (c): a pin's first seller agreed
-- only 94 %). So no wallet's Pinnacle rips reached its pack history.
-- Measured 2026-09-29: the open tx carries PackNFT.Opened(pack id) and, for
-- each pulled pin, Pinnacle.Withdraw(from: 0xb6f2481eba4df97b) ->
-- Pinnacle.Deposit(id, to: <the opener>) -- a RECORD, not an inference. Every
-- open has open_tx + open_block, all at or after the mainnet24 root (Pinnacle
-- launched 2023-12), in 13,705 distinct 250-block windows -- one events read
-- per window attributes every open in it.
--
-- WHAT.
--   pinnacle_pack_opens_keep_opener (BEFORE UPDATE trigger): a NULL never
--     overwrites a known opener -- the ingest upserts every row it re-reads
--     with opener_address NULL.
--   pinnacle_opener_windows: one row per (spork, 250-block window) holding an
--     open with no opener; bounds clamped to the spork.
--   run_pinnacle_opener_lane(): collect (opener = the `to` of the open tx's
--     Pinnacle.Deposit of one of the pack's pins; the most common one if they
--     differ), enqueue (every 10 min; a done window is re-read when an open
--     with no opener was ingested after it finished), dispatch (<= 10 per node
--     per tick; 429 = free retry). pg_cron rpc-pinnacle-opener-lane every minute.
-- anon-exec: pinnacle_pack_opens_keep_opener() — new trigger fn; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: run_pinnacle_opener_lane() — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   SELECT cron.unschedule('rpc-pinnacle-opener-lane');
--   DROP TRIGGER pinnacle_pack_opens_keep_opener ON public.pinnacle_pack_opens;
--   UPDATE public.pinnacle_pack_opens SET opener_address = NULL;
--   DROP FUNCTION public.run_pinnacle_opener_lane(), public.pinnacle_pack_opens_keep_opener();
--   DROP TABLE public.pinnacle_opener_windows;

CREATE OR REPLACE FUNCTION public.pinnacle_pack_opens_keep_opener()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- the ingest re-upserts rows with opener_address NULL (Dapper names the
  -- custodian); an opener read on chain must survive that
  IF NEW.opener_address IS NULL AND OLD.opener_address IS NOT NULL THEN
    NEW.opener_address := OLD.opener_address;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS pinnacle_pack_opens_keep_opener ON public.pinnacle_pack_opens;
CREATE TRIGGER pinnacle_pack_opens_keep_opener
  BEFORE UPDATE ON public.pinnacle_pack_opens
  FOR EACH ROW EXECUTE FUNCTION public.pinnacle_pack_opens_keep_opener();

CREATE TABLE IF NOT EXISTS public.pinnacle_opener_windows (
  spork          int NOT NULL,
  win            bigint NOT NULL,
  lo             bigint NOT NULL,
  hi             bigint NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  request_id     bigint,
  attempts       int NOT NULL DEFAULT 0,
  dispatched_at  timestamptz,
  finished_at    timestamptz,
  n_opens        int,
  n_attributed   int,
  last_error     text,
  PRIMARY KEY (spork, win)
);
COMMENT ON TABLE public.pinnacle_opener_windows IS
  'One Pinnacle.Deposit events read per (spork, 250-block window) holding a Disney Pinnacle pack open with no opener; run_pinnacle_opener_lane() attributes the opens from it.';
CREATE INDEX IF NOT EXISTS idx_pinnacle_opener_windows_status ON public.pinnacle_opener_windows (status, win DESC);
ALTER TABLE public.pinnacle_opener_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_opener_windows FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_pinnacle_pack_opens_no_opener
  ON public.pinnacle_pack_opens (open_block) WHERE opener_address IS NULL;
CREATE INDEX IF NOT EXISTS idx_pinnacle_pack_opens_open_tx ON public.pinnacle_pack_opens (open_tx);


-- ── run_pinnacle_opener_lane ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_pinnacle_opener_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_per_node constant int := 10;
  v_max_att  constant int := 6;
  -- mainnet24..27 roots/ends; 28 = current spork
  v_roots    constant bigint[] := ARRAY[65264619, 85981135, 88226267, 130290659, 137390146]::bigint[];
  v_ends     constant bigint[] := ARRAY[85981134, 88226266, 130290658, 137390145, 9223372036854775807]::bigint[];
  v_nodes    constant text[] := ARRAY['http://access-001.mainnet24.nodes.onflow.org:8070',
                                      'http://access-001.mainnet25.nodes.onflow.org:8070',
                                      'http://access-001.mainnet26.nodes.onflow.org:8070',
                                      'http://access-001.mainnet27.nodes.onflow.org:8070',
                                      'https://rest-mainnet.onflow.org'];
  r record;
  v_body jsonb; v_n int; v_req bigint;
  v_collected int := 0; v_done int := 0; v_attributed int := 0; v_failed int := 0; v_throttled int := 0;
  v_expired int := 0; v_enqueued int := 0; v_dispatched int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pinnacle_opener_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (1) Collect.
  FOR r IN
    SELECT w.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
      FROM public.pinnacle_opener_windows w
      LEFT JOIN net._http_response h ON h.id = w.request_id
     WHERE w.status = 'in_flight'
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.pinnacle_opener_windows
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = 'no_response'
         WHERE spork = r.spork AND win = r.win;
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;
    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN r.h_content::jsonb END;
    IF v_body IS NULL OR jsonb_typeof(v_body) IS DISTINCT FROM 'array' THEN
      IF r.h_status = 429 THEN
        UPDATE public.pinnacle_opener_windows SET status = 'pending', request_id = NULL, last_error = 'http 429'
         WHERE spork = r.spork AND win = r.win;
        v_throttled := v_throttled + 1;
      ELSE
        v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
        UPDATE public.pinnacle_opener_windows
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = v_last_error,
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE spork = r.spork AND win = r.win;
        v_failed := v_failed + 1;
      END IF;
      CONTINUE;
    END IF;

    WITH ev AS MATERIALIZED (
      SELECT e->>'transaction_id' AS tx,
             convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb AS pl
        FROM jsonb_array_elements(v_body) b
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e
    ), d AS MATERIALIZED (
      SELECT tx,
             (SELECT x->'value'->>'value' FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'id') AS pin_id,
             (SELECT coalesce(x->'value'->'value'->>'value', x->'value'->>'value')
                FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'to') AS to_addr
        FROM ev
    ), m AS (
      -- per open: the most common recipient of its pins in its own tx
      SELECT DISTINCT ON (o.pack_nft_id) o.pack_nft_id, d.to_addr
        FROM public.pinnacle_pack_opens o
        JOIN d ON d.tx = o.open_tx AND d.pin_id = ANY (o.nft_ids)
       WHERE o.opener_address IS NULL AND o.open_block BETWEEN r.lo AND r.hi AND d.to_addr IS NOT NULL
       GROUP BY o.pack_nft_id, d.to_addr
       ORDER BY o.pack_nft_id, count(*) DESC, d.to_addr
    ), upd AS (
      UPDATE public.pinnacle_pack_opens o SET opener_address = m.to_addr
        FROM m WHERE o.pack_nft_id = m.pack_nft_id AND o.opener_address IS NULL
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM upd;
    v_attributed := v_attributed + v_n;

    UPDATE public.pinnacle_opener_windows
       SET status = 'done', finished_at = now(), request_id = NULL, last_error = NULL, n_attributed = v_n,
           n_opens = (SELECT count(*) FROM public.pinnacle_pack_opens o WHERE o.open_block BETWEEN r.lo AND r.hi)
     WHERE spork = r.spork AND win = r.win;
    v_done := v_done + 1;
  END LOOP;

  -- (2) Enqueue (every 10 minutes, or when nothing is pending): windows with
  -- an open that has no opener; a done window is re-read when such an open was
  -- ingested after it finished.
  IF extract(minute FROM now())::int % 10 = 0
     OR NOT EXISTS (SELECT 1 FROM public.pinnacle_opener_windows WHERE status = 'pending') THEN
    WITH o AS (
      SELECT (SELECT min(i) FROM generate_subscripts(v_ends, 1) i WHERE v_ends[i] >= p.open_block) AS sp,
             p.open_block / 250 AS win, max(p.ingested_at) AS last_ingested
        FROM public.pinnacle_pack_opens p
       WHERE p.opener_address IS NULL AND p.open_block >= v_roots[1]
       GROUP BY 1, 2
    ), ins AS (
      INSERT INTO public.pinnacle_opener_windows AS w (spork, win, lo, hi)
      SELECT o.sp, o.win, greatest(o.win * 250, v_roots[o.sp]), least(o.win * 250 + 249, v_ends[o.sp])
        FROM o WHERE o.sp IS NOT NULL
      ON CONFLICT (spork, win) DO UPDATE
        SET status = 'pending', request_id = NULL, attempts = 0
        WHERE w.status = 'done'
          AND w.finished_at < (SELECT max(p2.ingested_at) FROM public.pinnacle_pack_opens p2
                                WHERE p2.opener_address IS NULL AND p2.open_block BETWEEN w.lo AND w.hi)
      RETURNING 1
    )
    SELECT count(*) INTO v_enqueued FROM ins;
  END IF;

  -- (3) Dispatch: <= v_per_node per spork node, newest windows first.
  FOR r IN
    SELECT * FROM (
      SELECT w.*, row_number() OVER (PARTITION BY w.spork ORDER BY w.win DESC) AS rn
        FROM public.pinnacle_opener_windows w WHERE w.status = 'pending'
    ) z WHERE rn <= v_per_node
  LOOP
    SELECT net.http_get(
      url := v_nodes[r.spork] || '/v1/events?type=A.edf9df96c92f4595.Pinnacle.Deposit&start_height=' || r.lo || '&end_height=' || r.hi,
      timeout_milliseconds := 30000
    ) INTO v_req;
    UPDATE public.pinnacle_opener_windows
       SET status = 'in_flight', request_id = v_req, dispatched_at = now()
     WHERE spork = r.spork AND win = r.win;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pinnacle-pack-openers', v_started, v_collected, v_attributed, 0, (v_failed = 0), v_last_error,
    'disney_pinnacle', NULL, NULL,
    jsonb_build_object('windows_done', v_done, 'attributed', v_attributed, 'failed', v_failed,
                       'throttled', v_throttled, 'expired', v_expired, 'enqueued', v_enqueued,
                       'dispatched', v_dispatched));
  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'windows_done', v_done,
                            'attributed', v_attributed, 'failed', v_failed, 'throttled', v_throttled,
                            'expired', v_expired, 'enqueued', v_enqueued, 'dispatched', v_dispatched,
                            'last_error', v_last_error);
END;
$function$;

REVOKE ALL ON FUNCTION public.pinnacle_pack_opens_keep_opener() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_pinnacle_opener_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_pinnacle_opener_lane() TO postgres, service_role;

SELECT cron.schedule('rpc-pinnacle-opener-lane', '* * * * *', 'SELECT public.run_pinnacle_opener_lane();');
