-- audit_20261031_topshot_lock_events_lane
--
-- 2026-10-31 ~10:15 PM PT (Claude Code cloud; Trevor: "Keep going"; known-issue #222 step 2).
-- wallet_moments_cache.is_locked was a POLLED cache: the lock-check cron re-reads ~53k rows/day
-- against 185k Top Shot rows in saved wallets alone (median lock_checked_at age 88 h, max 168 h),
-- so a collector who bulk-locked 121 Moments at 8:53 AM PT 10-31 saw them "unlocked" all day.
--
-- LOCK STATE IS EVENT-COMPLETE, so it can be followed instead of polled. Verified on mainnet
-- (TopShotLocking source read 10-31 via pg_net): isLocked(nft) = lockedNFTs.containsKey(id); an
-- expiry never removes a key on its own; every write to lockedNFTs emits — lock/admin-relock emit
-- MomentLocked(id, duration, expiryTimestamp), both removal paths emit MomentUnlocked(id). Volume
-- is tiny (4 events in 250 blocks measured), so one events call per type per 250 blocks suffices.
--
-- WHAT THIS ADDS:
--   · topshot_lock_event_state / topshot_lock_event_requests (RLS on, no anon/authenticated).
--   · topshot_lock_events_apply(body, locked) — one UPDATE: for each moment the LAST event in the
--     page wins; a row is written only when its lock_checked_at is older than the event's block
--     time, so pages may land in any order and a newer poll is never overwritten. lock_checked_at
--     becomes the block time the state was set. Scoped by collection_id (a moment_id is unique only
--     within a collection — CLAUDE.md), every wallet's row for that NFT (lock is the NFT's).
--   · topshot_lock_events_request(kind, start, end, attempt) — the one pg_net GET + request row.
--   · topshot_lock_events_tick() — pg_cron every minute: drain (403/408/429/5xx/no-response re-asked
--     up to 3 attempts; anything else fails the run) → ask the sealed height → dispatch ≤6 ranges
--     (12 requests, ≤12 in flight) up to the last KNOWN sealed height. First run starts 216,000
--     blocks back (~2 days, 10-29 ~10 PM PT measured) — the 7-day poll covers older state.
--   · pipeline_cadence_watchlist row 'topshot-lock-events' (30 min).
-- ⚠ Known limit: a lock and an unlock of the SAME moment with the SAME block timestamp resolve
--   by whichever page drains first (strict <). Rare; the poll corrects it within its cycle.
--
-- anon-exec: revoked (topshot_lock_events_apply) — new internal fn; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: revoked (topshot_lock_events_request) — new internal fn; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: revoked (topshot_lock_events_tick) — new pg_cron fn; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-lock-events');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-lock-events';
--   DROP FUNCTION public.topshot_lock_events_tick(); DROP FUNCTION public.topshot_lock_events_request(text, bigint, bigint, integer);
--   DROP FUNCTION public.topshot_lock_events_apply(jsonb, boolean);
--   DROP TABLE public.topshot_lock_event_requests, public.topshot_lock_event_state;

CREATE TABLE IF NOT EXISTS public.topshot_lock_event_state (
  id            integer PRIMARY KEY CHECK (id = 1),
  next_height   bigint,
  sealed_height bigint,
  sealed_at     timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.topshot_lock_event_state (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.topshot_lock_event_requests (
  request_id    bigint      PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('sealed', 'locked', 'unlocked')),
  start_h       bigint,
  end_h         bigint,
  attempt       integer     NOT NULL DEFAULT 1,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  drained_at    timestamptz,
  status_code   integer,
  events        integer,
  rows_updated  integer,
  error         text
);
CREATE INDEX IF NOT EXISTS idx_topshot_lock_event_requests_open
  ON public.topshot_lock_event_requests (kind) WHERE drained_at IS NULL;

ALTER TABLE public.topshot_lock_event_state    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topshot_lock_event_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_lock_event_state, public.topshot_lock_event_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.topshot_lock_events_apply(p_body jsonb, p_locked boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_events integer;
  v_rows   integer;
BEGIN
  WITH ev AS (
    SELECT convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb #>> '{value,fields,0,value,value}' AS moment_id,
           (b->>'block_timestamp')::timestamptz AS ts, (b->>'block_height')::bigint AS bh, (e->>'event_index')::integer AS ei
      FROM jsonb_array_elements(p_body) b
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b->'events', '[]'::jsonb)) e
     WHERE e->>'payload' ~ '^[A-Za-z0-9+/=]+$'
  ), last AS (
    SELECT DISTINCT ON (moment_id) moment_id, ts
      FROM ev WHERE moment_id ~ '^[0-9]+$'
     ORDER BY moment_id, bh DESC, ei DESC
  ), upd AS (
    UPDATE public.wallet_moments_cache w
       SET is_locked = p_locked, lock_checked_at = l.ts
      FROM last l
     WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       AND w.moment_id = l.moment_id
       AND (w.lock_checked_at IS NULL OR w.lock_checked_at < l.ts)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ev), (SELECT count(*) FROM upd) INTO v_events, v_rows;
  RETURN jsonb_build_object('events', v_events, 'rows', v_rows);
END;
$function$;

CREATE OR REPLACE FUNCTION public.topshot_lock_events_request(p_kind text, p_start bigint, p_end bigint, p_attempt integer)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req bigint;
  v_url text;
BEGIN
  v_url := CASE p_kind
    WHEN 'sealed' THEN 'https://rest-mainnet.onflow.org/v1/blocks?height=sealed'
    ELSE 'https://rest-mainnet.onflow.org/v1/events?type=A.0b2a3299cc857e29.TopShotLocking.'
         || CASE p_kind WHEN 'locked' THEN 'MomentLocked' ELSE 'MomentUnlocked' END
         || '&start_height=' || p_start || '&end_height=' || p_end END;
  v_req := net.http_get(url := v_url, timeout_milliseconds := 30000);
  INSERT INTO public.topshot_lock_event_requests (request_id, kind, start_h, end_h, attempt)
  VALUES (v_req, p_kind, p_start, p_end, p_attempt);
  RETURN v_req;
END;
$function$;

CREATE OR REPLACE FUNCTION public.topshot_lock_events_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  MAX_ATTEMPTS constant integer := 3;
  RANGE_BLOCKS constant integer := 250;   -- Flow REST's maximum events range
  PER_TICK     constant integer := 6;     -- ranges dispatched per tick (2 requests each)
  MAX_INFLIGHT constant integer := 12;    -- undrained event requests
  BACKFILL     constant bigint  := 216000; -- ~2 days of blocks on the first run
  v_started  timestamptz := clock_timestamp();
  r          record;
  s          public.topshot_lock_event_state%ROWTYPE;
  v_body     jsonb;
  v_res      jsonb;
  v_retry    boolean;
  v_pages    integer := 0;
  v_failed   integer := 0;
  v_retried  integer := 0;
  v_events   integer := 0;
  v_rows     integer := 0;
  v_sent     integer := 0;
  v_inflight integer;
  v_end      bigint;
  v_errors   jsonb := '[]'::jsonb;
BEGIN
  DELETE FROM public.topshot_lock_event_requests WHERE drained_at < now() - interval '2 days';

  -- ── drain ────────────────────────────────────────────────────────────────
  FOR r IN
    SELECT q.request_id, q.kind, q.start_h, q.end_h, q.attempt,
           h.status_code, h.error_msg, h.content, (h.id IS NOT NULL) AS has_resp
      FROM public.topshot_lock_event_requests q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.drained_at IS NULL
       AND (h.id IS NOT NULL OR q.dispatched_at < now() - interval '5 minutes')
     ORDER BY q.request_id
     LIMIT 60
  LOOP
    v_body := CASE WHEN r.has_resp AND r.status_code = 200 AND r.content IS NOT NULL
                        AND pg_input_is_valid(r.content, 'jsonb') THEN r.content::jsonb END;
    IF r.kind = 'sealed' THEN
      -- The next tick asks again; a missed height only delays dispatch by a minute.
      IF v_body IS NOT NULL AND v_body -> 0 -> 'header' ->> 'height' ~ '^[0-9]+$' THEN
        UPDATE public.topshot_lock_event_state
           SET sealed_height = greatest(coalesce(sealed_height, 0), (v_body -> 0 -> 'header' ->> 'height')::bigint),
               sealed_at = clock_timestamp(), updated_at = now()
         WHERE id = 1;
      END IF;
      UPDATE public.topshot_lock_event_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code,
             error = CASE WHEN v_body IS NULL THEN coalesce(r.status_code::text, 'no-response') END
       WHERE request_id = r.request_id;
      CONTINUE;
    END IF;

    v_pages := v_pages + 1;
    IF v_body IS NULL OR jsonb_typeof(v_body) IS DISTINCT FROM 'array' THEN
      v_retry := r.attempt < MAX_ATTEMPTS
                 AND (NOT r.has_resp OR r.status_code IS NULL
                      OR r.status_code IN (403, 408, 429) OR r.status_code >= 500);
      UPDATE public.topshot_lock_event_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code,
             error = CASE WHEN v_retry THEN 'retried ' ELSE '' END
                  || CASE WHEN NOT r.has_resp THEN 'no-response'
                          ELSE coalesce(r.status_code::text, 'no-status') || ': ' || left(coalesce(r.error_msg, r.content, ''), 200) END
       WHERE request_id = r.request_id;
      IF v_retry THEN
        PERFORM public.topshot_lock_events_request(r.kind, r.start_h, r.end_h, r.attempt + 1);
        v_retried := v_retried + 1;
      ELSE
        v_failed := v_failed + 1;
        v_errors := v_errors || jsonb_build_object('kind', r.kind, 'start', r.start_h, 'status', r.status_code);
      END IF;
      CONTINUE;
    END IF;

    v_res := public.topshot_lock_events_apply(v_body, r.kind = 'locked');
    v_events := v_events + (v_res ->> 'events')::integer;
    v_rows := v_rows + (v_res ->> 'rows')::integer;
    UPDATE public.topshot_lock_event_requests
       SET drained_at = clock_timestamp(), status_code = 200,
           events = (v_res ->> 'events')::integer, rows_updated = (v_res ->> 'rows')::integer
     WHERE request_id = r.request_id;
  END LOOP;

  -- ── dispatch ─────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.topshot_lock_event_requests WHERE kind = 'sealed' AND drained_at IS NULL) THEN
    PERFORM public.topshot_lock_events_request('sealed', NULL, NULL, 1);
  END IF;
  SELECT * INTO s FROM public.topshot_lock_event_state WHERE id = 1;
  IF s.sealed_height IS NOT NULL THEN
    IF s.next_height IS NULL THEN
      UPDATE public.topshot_lock_event_state SET next_height = s.sealed_height - BACKFILL, updated_at = now()
       WHERE id = 1 RETURNING * INTO s;
    END IF;
    SELECT count(*) INTO v_inflight FROM public.topshot_lock_event_requests
     WHERE kind <> 'sealed' AND drained_at IS NULL;
    FOR i IN 1 .. PER_TICK LOOP
      EXIT WHEN v_inflight + 2 > MAX_INFLIGHT OR s.next_height > s.sealed_height;
      v_end := least(s.next_height + RANGE_BLOCKS - 1, s.sealed_height);
      PERFORM public.topshot_lock_events_request('locked', s.next_height, v_end, 1);
      PERFORM public.topshot_lock_events_request('unlocked', s.next_height, v_end, 1);
      v_inflight := v_inflight + 2;
      v_sent := v_sent + 2;
      UPDATE public.topshot_lock_event_state SET next_height = v_end + 1, updated_at = now()
       WHERE id = 1 RETURNING * INTO s;
    END LOOP;
  END IF;

  IF v_pages > 0 THEN
    -- ok = no page failed for good. rows_written = wmc rows whose lock state an event changed.
    PERFORM public.log_pipeline_run(
      'topshot-lock-events', v_started, v_events, v_rows, v_failed,
      v_failed = 0,
      CASE WHEN v_failed > 0 THEN v_failed || ' page(s) failed' END,
      'nba_top_shot', NULL, s.next_height::text,
      jsonb_build_object('pages', v_pages, 'pages_failed', v_failed, 'pages_retried', v_retried,
                         'events', v_events, 'rows_updated', v_rows, 'sent', v_sent,
                         'lag_blocks', s.sealed_height - s.next_height + 1, 'errors_sample', v_errors));
  END IF;
  RETURN jsonb_build_object('pages', v_pages, 'failed', v_failed, 'retried', v_retried, 'events', v_events,
                            'rows', v_rows, 'sent', v_sent, 'next_height', s.next_height, 'sealed_height', s.sealed_height);
END;
$function$;

REVOKE ALL ON FUNCTION public.topshot_lock_events_apply(jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.topshot_lock_events_request(text, bigint, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.topshot_lock_events_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_lock_events_tick() TO service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES ('topshot-lock-events', 30, 'medium',
        'TopShotLocking MomentLocked/MomentUnlocked events -> wallet_moments_cache.is_locked (pg_cron every minute; logs on ticks that drained an events page). #222.',
        true)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-topshot-lock-events', '* * * * *', 'SELECT public.topshot_lock_events_tick()');
