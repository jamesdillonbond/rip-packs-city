-- 2026-10-19 (PT) — an edition-level autograph flag for NBA Top Shot and NFL All Day, from Atlas.
--
-- Source of truth: Atlas EditionService/SearchEditions returns `autographedAt` per edition (null =
-- unsigned). Nothing else carries it: not the Top Shot GQL tags badge_editions syncs, not the pack
-- tier counts (`autograph` = 0 even on packs that held signed Moments), not set or parallel names
-- (only 55 of Top Shot's 236 signed editions sit in a set named "Signature …"), and not prices
-- (signed Hardcourts trade 2.97x their Blockchain, unsigned 2.11x, ranges overlapping).
-- Census 2026-10-19 ~7:30 PM PT (docs/research/autographs-topshot-allday-2026-10-19.md;
-- raw rows public.audit_20261019_autograph_editions): 14,450 nba + 5,835 nfl rows = Atlas totalCount;
-- 236 + 226 = 462 signed; every signed edition joins to an RPC edition.
--
-- Shape:
--   * editions.autographed_at — written ONLY when the value changes, because editions.updated_at is
--     the sitemap's lastModified and a daily touch of every row would churn it (lib/sitemap-data.ts).
--     NULL means "not signed OR never checked"; tell them apart with edition_autograph_checks.
--   * edition_autograph_checks(edition_id, autographed_at, checked_at) — one row per edition Atlas
--     returned in a sweep, re-stamped every cycle. A positive claim ("Signed") needs only the
--     editions column; a NEGATIVE claim ("not signed") needs a check row.
--   * autograph_sweep_tick() — pg_cron every 2 minutes: drain finished pg_net responses, then
--     dispatch the next 2 pages per product (100 editions a page, the API cap). A cycle covers
--     ~145 + 59 pages and starts again 20 h after the previous one finished. A non-200 page
--     (Cloudflare 403s ~10–30 % of bursts) stays pending and is retried on a later tick.
--   * Honesty: rows_written = editions whose autographed_at CHANGED + check rows written; ok=false
--     whenever a page failed to parse or a write raised; a page counts as done only from a 200.
--
-- Join keys (verified 2026-10-19): Top Shot via topshot_atlas_edition_map.atlas_edition_id (1:1,
-- 14,394 rows, 0 duplicates); All Day via editions.external_id = the Atlas edition id.
--
-- Exit: pipeline 'autograph-sweep' logs every 2 min; a full cycle completes daily (state
-- cycle_finished_at advances); signed counts stay >= 236 / 226.
-- Falsifier: an edition whose Atlas autographedAt is set while editions.autographed_at is NULL
-- with a check row newer than that cycle.
-- Revert:
--   SELECT cron.unschedule('rpc-autograph-sweep');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'autograph-sweep';
--   DROP FUNCTION public.autograph_sweep_tick(integer);
--   DROP TABLE public.autograph_sweep_requests, public.autograph_sweep_state, public.edition_autograph_checks;
--   ALTER TABLE public.editions DROP COLUMN autographed_at;

ALTER TABLE public.editions ADD COLUMN IF NOT EXISTS autographed_at timestamptz;
COMMENT ON COLUMN public.editions.autographed_at IS
  'Atlas autographedAt for this edition (NBA Top Shot / NFL All Day): NOT NULL = a signed edition. NULL = unsigned OR never checked — see edition_autograph_checks. Written only on change by autograph_sweep_tick().';

CREATE INDEX IF NOT EXISTS idx_editions_autographed
  ON public.editions (collection_id) WHERE autographed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.edition_autograph_checks (
  edition_id     uuid PRIMARY KEY,  -- no FK: edition merges remove editions rows, and a check row must never block one
  autographed_at timestamptz,
  checked_at     timestamptz NOT NULL
);
COMMENT ON TABLE public.edition_autograph_checks IS
  'When Atlas last confirmed each edition''s autograph state (autograph_sweep_tick). A row = checked; autographed_at NULL here = verified unsigned at checked_at.';
ALTER TABLE public.edition_autograph_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.edition_autograph_checks FROM anon, authenticated;
GRANT SELECT ON public.edition_autograph_checks TO anon, authenticated;
CREATE POLICY edition_autograph_checks_read ON public.edition_autograph_checks FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.autograph_sweep_state (
  product           text PRIMARY KEY CHECK (product IN ('nba', 'nfl')),
  cycle_started_at  timestamptz,
  cycle_finished_at timestamptz,
  total_count       integer
);
ALTER TABLE public.autograph_sweep_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.autograph_sweep_state FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.autograph_sweep_requests (
  request_id       bigint PRIMARY KEY,
  product          text NOT NULL,
  page_offset      integer NOT NULL,
  cycle_started_at timestamptz NOT NULL,
  dispatched_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  drained_at       timestamptz,
  status_code      integer,
  rows_seen        integer,
  rows_written     integer,
  error            text
);
CREATE INDEX IF NOT EXISTS idx_autograph_sweep_requests_open ON public.autograph_sweep_requests (dispatched_at) WHERE drained_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_autograph_sweep_requests_cycle ON public.autograph_sweep_requests (product, cycle_started_at, page_offset);
ALTER TABLE public.autograph_sweep_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.autograph_sweep_requests FROM anon, authenticated;

-- Seed from the 2026-10-19 census (the cycle it completed counts as the first; the next starts 20 h later).
INSERT INTO public.autograph_sweep_state (product, cycle_started_at, cycle_finished_at, total_count) VALUES
  ('nba', '2026-10-20 02:10:00+00', '2026-10-20 02:40:00+00', 14450),
  ('nfl', '2026-10-20 02:10:00+00', '2026-10-20 02:25:00+00', 5835)
ON CONFLICT (product) DO NOTHING;

INSERT INTO public.edition_autograph_checks (edition_id, autographed_at, checked_at)
SELECT m.rpc_edition_id, a.autographed_at, '2026-10-20 02:40:00+00'::timestamptz
  FROM public.audit_20261019_autograph_editions a
  JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = a.atlas_edition_id
 WHERE a.product = 'nba'
UNION ALL
SELECT e.id, a.autographed_at, '2026-10-20 02:25:00+00'::timestamptz
  FROM public.audit_20261019_autograph_editions a
  JOIN public.editions e ON e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND e.external_id = a.atlas_edition_id
 WHERE a.product = 'nfl'
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e
   SET autographed_at = c.autographed_at
  FROM public.edition_autograph_checks c
 WHERE c.edition_id = e.id
   AND c.autographed_at IS NOT NULL
   AND e.autographed_at IS DISTINCT FROM c.autographed_at;

CREATE OR REPLACE FUNCTION public.autograph_sweep_tick(p_pages_per_product integer DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_started  timestamptz := clock_timestamp();
  r          record;
  s          record;
  v_body     jsonb;
  v_seen     integer;
  v_changed  integer;
  v_checked  integer;
  v_drained  integer := 0;
  v_pages_ok integer := 0;
  v_pages_bad integer := 0;
  v_changed_total integer := 0;
  v_checked_total integer := 0;
  v_dispatched integer := 0;
  v_errors   text[] := '{}';
  v_offset   integer;
BEGIN
  -- 1. Drain: every dispatched request whose response has arrived (or that has waited 10 min).
  FOR r IN
    SELECT q.request_id, q.product, q.page_offset, q.cycle_started_at, h.status_code, h.content, h.error_msg,
           (h.id IS NULL) AS missing
      FROM public.autograph_sweep_requests q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.drained_at IS NULL
       AND (h.id IS NOT NULL OR q.dispatched_at < clock_timestamp() - interval '10 minutes')
     ORDER BY q.request_id
     LIMIT 20
  LOOP
    v_drained := v_drained + 1;
    IF r.missing OR r.status_code IS DISTINCT FROM 200 OR left(coalesce(r.content, ''), 1) <> '{' THEN
      v_pages_bad := v_pages_bad + 1;
      UPDATE public.autograph_sweep_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code,
             error = CASE WHEN r.missing THEN 'no_response' ELSE coalesce(left(r.error_msg, 200), 'http_' || coalesce(r.status_code::text, 'null')) END
       WHERE request_id = r.request_id;
      CONTINUE;
    END IF;

    BEGIN
      v_body := r.content::jsonb;

      -- One statement: parse the page, resolve each Atlas id to an RPC edition, write the flag on
      -- change, re-stamp every check row. (Data-modifying CTEs all run, whether or not they are read.)
      WITH page AS (
        SELECT x->>'id' AS atlas_id, nullif(x->>'autographedAt', '')::timestamptz AS autographed_at
          FROM jsonb_array_elements(coalesce(v_body->'editions', '[]'::jsonb)) x
         WHERE x->>'id' IS NOT NULL
      ), tgt AS (
        SELECT m.rpc_edition_id AS edition_id, p.autographed_at
          FROM page p JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = p.atlas_id
         WHERE r.product = 'nba'
        UNION ALL
        SELECT e.id, p.autographed_at
          FROM page p JOIN public.editions e
            ON e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND e.external_id = p.atlas_id
         WHERE r.product = 'nfl'
      ), upd AS (
        UPDATE public.editions e SET autographed_at = t.autographed_at
          FROM tgt t
         WHERE e.id = t.edition_id AND e.autographed_at IS DISTINCT FROM t.autographed_at
        RETURNING 1
      ), chk AS (
        INSERT INTO public.edition_autograph_checks (edition_id, autographed_at, checked_at)
        SELECT edition_id, autographed_at, clock_timestamp() FROM tgt
        ON CONFLICT (edition_id) DO UPDATE SET autographed_at = EXCLUDED.autographed_at, checked_at = EXCLUDED.checked_at
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM page), (SELECT count(*) FROM upd), (SELECT count(*) FROM chk)
        INTO v_seen, v_changed, v_checked;

      IF (v_body->'pagination'->>'totalCount') ~ '^[0-9]+$' THEN
        UPDATE public.autograph_sweep_state SET total_count = (v_body->'pagination'->>'totalCount')::int
         WHERE product = r.product;
      END IF;

      UPDATE public.autograph_sweep_requests
         SET drained_at = clock_timestamp(), status_code = 200, rows_seen = v_seen, rows_written = v_changed + v_checked, error = NULL
       WHERE request_id = r.request_id;
      v_pages_ok := v_pages_ok + 1;
      v_changed_total := v_changed_total + v_changed;
      v_checked_total := v_checked_total + v_checked;
    -- when-others-timeout-blind: intentional — this handler records one page and the loop CONTINUES, so a
    -- caught 57014 would run on with the timer disarmed; a kill must end the run (the tick's next run retries).
    EXCEPTION WHEN OTHERS THEN
      v_pages_bad := v_pages_bad + 1;
      v_errors := v_errors || left(SQLERRM, 200);
      UPDATE public.autograph_sweep_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code, error = 'parse_or_write: ' || left(SQLERRM, 200)
       WHERE request_id = r.request_id;
    END;
  END LOOP;

  -- 2. Close or open cycles, then dispatch the next pending pages per product.
  FOR s IN SELECT * FROM public.autograph_sweep_state ORDER BY product LOOP
    IF s.cycle_finished_at IS NOT NULL AND s.cycle_finished_at >= s.cycle_started_at THEN
      IF s.cycle_finished_at > clock_timestamp() - interval '20 hours' THEN
        CONTINUE;  -- finished recently: idle until the next daily cycle
      END IF;
      UPDATE public.autograph_sweep_state SET cycle_started_at = clock_timestamp(), cycle_finished_at = NULL
       WHERE product = s.product
      RETURNING * INTO s;
    END IF;

    v_offset := NULL;
    FOR r IN
      SELECT o AS page_offset
        FROM generate_series(0, greatest(coalesce(s.total_count, 1) - 1, 0), 100) o
       WHERE NOT EXISTS (SELECT 1 FROM public.autograph_sweep_requests q
                          WHERE q.product = s.product AND q.cycle_started_at = s.cycle_started_at
                            AND q.page_offset = o
                            AND (q.status_code = 200 AND q.error IS NULL OR q.drained_at IS NULL))
       ORDER BY o
       LIMIT greatest(p_pages_per_product, 0)
    LOOP
      INSERT INTO public.autograph_sweep_requests (request_id, product, page_offset, cycle_started_at)
      VALUES (net.http_post(
                url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions',
                body := jsonb_build_object('product', s.product, 'limit', '100', 'offset', r.page_offset::text),
                headers := public.atlas_market_headers(s.product),
                timeout_milliseconds := 30000),
              s.product, r.page_offset, s.cycle_started_at);
      v_dispatched := v_dispatched + 1;
      v_offset := r.page_offset;
    END LOOP;

    -- Nothing left to dispatch and nothing in flight: the cycle is complete.
    IF v_offset IS NULL AND s.total_count IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.autograph_sweep_requests q
          WHERE q.product = s.product AND q.cycle_started_at = s.cycle_started_at AND q.drained_at IS NULL) THEN
      UPDATE public.autograph_sweep_state SET cycle_finished_at = clock_timestamp() WHERE product = s.product;
    END IF;
  END LOOP;

  -- No retention purge: ~250 request rows a day (~90k a year) is cheaper to keep than to prune.

  RETURN jsonb_build_object(
    'drained', v_drained, 'pages_ok', v_pages_ok, 'pages_failed', v_pages_bad,
    'editions_changed', v_changed_total, 'checks_written', v_checked_total,
    'dispatched', v_dispatched, 'errors', to_jsonb(v_errors),
    'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int);
END;
$fn$;
-- anon-exec: revoked (autograph_sweep_tick) — new SECDEF writer that dispatches HTTP; postgres/service_role only.
REVOKE EXECUTE ON FUNCTION public.autograph_sweep_tick(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.autograph_sweep_tick(integer) TO postgres, service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active, max_minutes_without_success)
VALUES ('autograph-sweep', 30, 'info',
  'pg_cron rpc-autograph-sweep (*/2 * * * * UTC, postgres) -> autograph_sweep_tick(2) wrapped in log_pipeline_run: drains Atlas SearchEditions pages into editions.autographed_at (on change) and edition_autograph_checks (every cycle), dispatches 2 pages per product. Idle ticks between daily cycles are normal (rows 0, ok). ok=false = a page failed to parse or a write raised; 403 pages are retried and count as pages_failed only.',
  true, 180)
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-autograph-sweep', '*/2 * * * *',
  $cmd$SELECT public.log_pipeline_run('autograph-sweep', now(), (x.r->>'pages_ok')::int, (x.r->>'editions_changed')::int + (x.r->>'checks_written')::int, (x.r->>'pages_failed')::int, jsonb_array_length(x.r->'errors') = 0, nullif(x.r->>'errors', '[]'), NULL, NULL, NULL, x.r || jsonb_build_object('via', 'pg_cron')) FROM (SELECT public.autograph_sweep_tick(2) AS r) x;$cmd$);
