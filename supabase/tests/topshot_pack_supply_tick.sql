-- DB invariant: public.topshot_pack_supply_tick + the issuer-held split readers
-- (topshot_issuer_held_split_editions, get_topshot_issuer_held_split). Pins:
--   · a summary 200 writes the counts and opens an edition pass only when Moments are
--     left; a fully-opened, closed drop is re-checked in 30 days, an open one in 20 h;
--   · a summary UNCHANGED since a pass that reconciled exactly keeps that pass (no
--     edition pages) and is re-read in 40 h; a changed one opens a new pass;
--   · edition pages land under their pass; a page from a superseded pass is recorded,
--     not written; the pass closes on the page that reaches totalCount and records
--     its row count + remaining sum;
--   · a failed summary moves next_due_at (30 min) and never the KNOW-stamp; a failed
--     edition page drops the pass; a request with no response after 15 min fails;
--     the run is not ok when any request failed;
--   · dispatch sends at most p_budget requests, edition pages before summaries, and
--     NOTHING while the market lane's last 10 minutes are mostly 403s, counted over
--     every drained market request (a tagged row is a success, not noise);
--   · the readers publish NULL (never 0) until the list is complete, every drop has a
--     summary and every drop with packs left is settled; then reserve = hidden − in
--     packs per edition and per tier; stale issuer-held rows are excluded AND
--     disclosed; more in packs than issuer-held is "contradicted", not a negative.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (topshot_pack_supply_tick: supabase/migrations/20261010213401_audit_20261010_topshot_pack_supply_carries_unchanged_passes_and_counts_tagged_market_rows.sql;
-- the two readers: supabase/migrations/20261003224608_audit_20261003_topshot_pack_supply_from_atlas_distribution_service.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if a copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code integer, error_msg text, content text);
CREATE SEQUENCE net.req_seq START 9000;
CREATE TABLE net.sent (id bigint, url text, body jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.sent VALUES (nextval('net.req_seq'), url, body) RETURNING id $$;

CREATE TABLE public.pipeline_log (pipeline text, rows_found integer, rows_written integer, ok boolean, error text, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found integer, p_rows_written integer,
  p_rows_skipped integer, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_log VALUES (p_pipeline, p_rows_found, p_rows_written, p_ok, p_error, p_extra) RETURNING 1::bigint $$;

CREATE TABLE public.topshot_atlas_market_requests (request_id bigint, dispatched_at timestamptz, error text, drained_at timestamptz);
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
INSERT INTO public.collections VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');
CREATE TABLE public.editions (collection_id uuid, subedition_id integer, subedition_name text);
INSERT INTO public.editions VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 9, 'Bit');
CREATE TABLE public.badge_editions (collection_id uuid, external_id text, tier text, hidden_in_packs integer, updated_at timestamptz);

-- >>> BEGIN table DDL (copied from the migration) >>>
CREATE TABLE IF NOT EXISTS public.topshot_atlas_pack_state (
  id               integer     PRIMARY KEY CHECK (id = 1),
  list_started_at  timestamptz,
  list_next_offset integer     NOT NULL DEFAULT 0,
  list_total       integer,
  list_done_at     timestamptz
);
INSERT INTO public.topshot_atlas_pack_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.topshot_atlas_dists (
  dist_id               text        PRIMARY KEY,
  title                 text,
  end_time              timestamptz,
  is_enabled            boolean,
  for_sale_supply       bigint,
  available_supply      bigint,
  total_supply          bigint,
  listed_at             timestamptz,
  -- summary (GetDistributionContentSummary)
  summary_pass          bigint,
  summary_fetched_at    timestamptz,
  unopened_count        bigint,
  owned_count           bigint,
  unavailable_count     bigint,
  total_pack_count      bigint,
  remaining_by_tier     jsonb,
  original_by_tier      jsonb,
  remaining_total       bigint,
  next_due_at           timestamptz,
  attempts              integer     NOT NULL DEFAULT 0,
  last_error            text,
  -- edition pass (GetDistributionEditions, hideOpened) for summary_pass
  editions_pass         bigint,
  editions_next_offset  integer,
  editions_total        integer,
  editions_done_at      timestamptz,
  edition_rows          integer,
  edition_remaining_sum bigint
);
CREATE INDEX IF NOT EXISTS topshot_atlas_dists_due_idx ON public.topshot_atlas_dists (next_due_at NULLS FIRST);
COMMENT ON COLUMN public.topshot_atlas_dists.summary_fetched_at IS
  'KNOW-stamp: when the summary counts on this row were read from Atlas (only a 200 writes it). A failed read moves next_due_at, never this.';
COMMENT ON COLUMN public.topshot_atlas_dists.remaining_total IS
  'Σ remainingByTier: Moments inside this distribution''s packs that exist and are unopened (sold or unsold).';

CREATE TABLE IF NOT EXISTS public.topshot_atlas_dist_editions (
  dist_id          text        NOT NULL,
  atlas_edition_id text        NOT NULL,
  pass             bigint      NOT NULL,
  set_id           integer,
  play_id          integer,
  parallel         text,
  tier             text,
  original_count   bigint      NOT NULL,
  remaining_count  bigint      NOT NULL,
  hidden_at_fetch  bigint,
  fetched_at       timestamptz NOT NULL,
  PRIMARY KEY (dist_id, atlas_edition_id)
);
COMMENT ON COLUMN public.topshot_atlas_dist_editions.pass IS
  'The summary request this row was fetched under. Only rows whose pass = topshot_atlas_dists.editions_pass are current; older rows are left in place, never read.';

CREATE TABLE IF NOT EXISTS public.topshot_atlas_pack_requests (
  request_id    bigint      PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('list', 'summary', 'editions')),
  dist_id       text,
  offset_at     integer,
  pass          bigint,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  drained_at    timestamptz,
  status_code   integer,
  error         text
);
CREATE INDEX IF NOT EXISTS topshot_atlas_pack_requests_open_idx
  ON public.topshot_atlas_pack_requests (dispatched_at) WHERE drained_at IS NULL;
-- <<< END table DDL <<<

-- >>> BEGIN verbatim topshot_pack_supply_tick (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.topshot_pack_supply_tick(p_budget integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_url       constant text := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.DistributionService/';
  v_headers   constant jsonb := '{"content-type":"application/json","connect-protocol-version":"1","origin":"https://nbatopshot.com","referer":"https://nbatopshot.com/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"}'::jsonb;
  r           record;
  d           record;
  v_body      jsonb;
  v_n         integer;
  v_drained   integer := 0;
  v_failed    integer := 0;
  v_rows      integer := 0;
  v_sent      integer := 0;
  v_inflight  integer;
  v_req       bigint;
  v_state     public.topshot_atlas_pack_state%ROWTYPE;
  v_market403 integer;
  v_market    integer;
  v_held      boolean := false;
  v_errors    jsonb := '[]'::jsonb;
  v_same      boolean;
BEGIN
  DELETE FROM public.topshot_atlas_pack_requests WHERE drained_at < now() - interval '7 days';

  -- ── drain ────────────────────────────────────────────────────────────────
  FOR r IN
    SELECT q.request_id, q.kind, q.dist_id, q.offset_at, q.pass,
           h.status_code, h.error_msg, h.content, (h.id IS NOT NULL) AS has_resp
      FROM public.topshot_atlas_pack_requests q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.drained_at IS NULL
       AND (h.id IS NOT NULL OR q.dispatched_at < now() - interval '15 minutes')
     ORDER BY q.request_id
     LIMIT 40
  LOOP
    v_drained := v_drained + 1;
    v_body := CASE WHEN r.has_resp AND r.status_code = 200 AND r.content IS NOT NULL
                        AND pg_input_is_valid(r.content, 'jsonb') THEN r.content::jsonb END;
    IF v_body IS NULL
       OR (r.kind = 'list'     AND jsonb_typeof(v_body -> 'distributions') IS DISTINCT FROM 'array')
       OR (r.kind = 'summary'  AND jsonb_typeof(v_body -> 'remainingByTier') IS DISTINCT FROM 'object')
       OR (r.kind = 'editions' AND jsonb_typeof(v_body -> 'editions') IS DISTINCT FROM 'array') THEN
      v_failed := v_failed + 1;
      UPDATE public.topshot_atlas_pack_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code,
             error = CASE WHEN NOT r.has_resp THEN 'no-response'
                          ELSE coalesce(r.status_code::text, 'no-status') || ': ' || left(coalesce(r.error_msg, r.content, ''), 200) END
       WHERE request_id = r.request_id;
      v_errors := v_errors || jsonb_build_object('kind', r.kind, 'dist', r.dist_id, 'offset', r.offset_at, 'status', r.status_code);
      IF r.kind = 'list' THEN
        -- Re-ask the same page next tick: rewind the cursor to it if it ran past.
        UPDATE public.topshot_atlas_pack_state SET list_next_offset = least(list_next_offset, r.offset_at) WHERE id = 1;
      ELSIF r.kind = 'summary' THEN
        UPDATE public.topshot_atlas_dists
           SET next_due_at = now() + interval '30 minutes', attempts = attempts + 1,
               last_error = left(coalesce(r.status_code::text, 'no-response'), 40)
         WHERE dist_id = r.dist_id;
      ELSE
        -- A missing edition page makes this pass unreconcilable: drop it and re-read
        -- the summary (a new pass) in 30 minutes.
        UPDATE public.topshot_atlas_dists
           SET editions_done_at = NULL, editions_next_offset = NULL,
               next_due_at = now() + interval '30 minutes', attempts = attempts + 1,
               last_error = 'editions ' || left(coalesce(r.status_code::text, 'no-response'), 30)
         WHERE dist_id = r.dist_id AND editions_pass = r.pass;
      END IF;
      CONTINUE;
    END IF;

    IF r.kind = 'list' THEN
      INSERT INTO public.topshot_atlas_dists AS t
        (dist_id, title, end_time, is_enabled, for_sale_supply, available_supply, total_supply, listed_at)
      SELECT x->>'id', x->>'title', nullif(x->>'endTime', '')::timestamptz, (x->>'isEnabled')::boolean,
             nullif(x->>'forSaleSupply', '')::bigint, nullif(x->>'availableSupply', '')::bigint,
             nullif(x->>'totalSupply', '')::bigint, clock_timestamp()
        FROM jsonb_array_elements(v_body -> 'distributions') x
       WHERE x->>'id' ~ '^[0-9]+$'
      ON CONFLICT (dist_id) DO UPDATE
        SET title = EXCLUDED.title, end_time = EXCLUDED.end_time, is_enabled = EXCLUDED.is_enabled,
            for_sale_supply = EXCLUDED.for_sale_supply, available_supply = EXCLUDED.available_supply,
            total_supply = EXCLUDED.total_supply, listed_at = EXCLUDED.listed_at;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_rows := v_rows + v_n;
      UPDATE public.topshot_atlas_pack_state
         SET list_total = coalesce(nullif(v_body -> 'pagination' ->> 'totalCount', '')::integer, list_total),
             list_done_at = CASE WHEN coalesce((v_body -> 'pagination' ->> 'hasMore')::boolean,
                                               jsonb_array_length(v_body -> 'distributions') >= 100) = false
                                 THEN clock_timestamp() ELSE list_done_at END
       WHERE id = 1;

    ELSIF r.kind = 'summary' THEN
      SELECT sum(nullif(v.value, '')::bigint) INTO v_n
        FROM jsonb_each_text(v_body -> 'remainingByTier') v;
      -- Unchanged since a pass that reconciled exactly: carry that pass forward instead
      -- of re-reading every edition page (2026-10-10). Opens only lower a tier's count,
      -- so equal per-tier counts mean nothing in this drop was opened. Re-read in 40 h:
      -- re-reading 3,270 open drops every 20 h plus their pages needed ~2x what a
      -- 2-request tick can send, so the 48 h settle gate could never pass.
      SELECT t.remaining_by_tier = (v_body -> 'remainingByTier') AND t.editions_pass IS NOT NULL
             AND t.editions_done_at IS NOT NULL AND t.remaining_total = v_n AND t.edition_remaining_sum = v_n
        INTO v_same
        FROM public.topshot_atlas_dists t WHERE t.dist_id = r.dist_id;
      v_same := coalesce(v_same, false) AND coalesce(v_n, 0) > 0;
      UPDATE public.topshot_atlas_dists t
         SET summary_pass = r.request_id, summary_fetched_at = clock_timestamp(),
             unopened_count = nullif(v_body ->> 'unopenedCount', '')::bigint,
             owned_count = nullif(v_body ->> 'ownedCount', '')::bigint,
             unavailable_count = nullif(v_body ->> 'unavailableCount', '')::bigint,
             total_pack_count = nullif(v_body ->> 'totalPackCount', '')::bigint,
             remaining_by_tier = v_body -> 'remainingByTier',
             original_by_tier = v_body -> 'originalCountsByTier',
             remaining_total = v_n, attempts = 0, last_error = NULL,
             editions_pass = CASE WHEN v_same THEN t.editions_pass ELSE r.request_id END,
             editions_next_offset = CASE WHEN v_same THEN t.editions_next_offset WHEN v_n > 0 THEN 0 END,
             editions_total = CASE WHEN v_same THEN t.editions_total WHEN v_n > 0 THEN NULL ELSE 0 END,
             editions_done_at = CASE WHEN v_same THEN t.editions_done_at WHEN v_n > 0 THEN NULL ELSE clock_timestamp() END,
             edition_rows = CASE WHEN v_same THEN t.edition_rows WHEN v_n > 0 THEN NULL ELSE 0 END,
             edition_remaining_sum = CASE WHEN v_same THEN t.edition_remaining_sum WHEN v_n > 0 THEN NULL ELSE 0 END,
             -- Nothing left in a closed drop: re-check monthly. Unchanged: in 40 h.
             -- Anything else: daily.
             next_due_at = now() + CASE WHEN v_n = 0 AND coalesce(t.available_supply, 0) = 0
                                             AND coalesce(t.for_sale_supply, 0) = 0
                                             AND (t.end_time IS NULL OR t.end_time < now())
                                        THEN interval '30 days'
                                        WHEN v_same THEN interval '40 hours'
                                        ELSE interval '20 hours' END
       WHERE t.dist_id = r.dist_id;
      v_rows := v_rows + 1;

    ELSE
      SELECT * INTO d FROM public.topshot_atlas_dists WHERE dist_id = r.dist_id;
      IF d.editions_pass IS DISTINCT FROM r.pass THEN
        -- A page from a superseded pass: recorded, not written.
        UPDATE public.topshot_atlas_pack_requests
           SET drained_at = clock_timestamp(), status_code = 200, error = '__superseded__'
         WHERE request_id = r.request_id;
        CONTINUE;
      END IF;
      INSERT INTO public.topshot_atlas_dist_editions AS t
        (dist_id, atlas_edition_id, pass, set_id, play_id, parallel, tier,
         original_count, remaining_count, hidden_at_fetch, fetched_at)
      SELECT r.dist_id, coalesce(x->>'editionId', x->'edition'->>'id'), r.pass,
             nullif(x->'edition'->>'setId', '')::integer, nullif(x->'edition'->>'editionTemplateId', '')::integer,
             coalesce(nullif(x->'edition'->>'parallel', ''), 'Standard'),
             upper(regexp_replace(coalesce(x->'edition'->>'tier', ''), '^MOMENT_TIER_', '')),
             (x->>'originalCount')::bigint, (x->>'remainingCount')::bigint,
             nullif(x->'edition'->>'numHiddenInPacks', '')::bigint, clock_timestamp()
        FROM jsonb_array_elements(v_body -> 'editions') x
       WHERE coalesce(x->>'editionId', x->'edition'->>'id') IS NOT NULL
         AND x->>'originalCount' IS NOT NULL AND x->>'remainingCount' IS NOT NULL
      ON CONFLICT (dist_id, atlas_edition_id) DO UPDATE
        SET pass = EXCLUDED.pass, set_id = EXCLUDED.set_id, play_id = EXCLUDED.play_id,
            parallel = EXCLUDED.parallel, tier = EXCLUDED.tier,
            original_count = EXCLUDED.original_count, remaining_count = EXCLUDED.remaining_count,
            hidden_at_fetch = EXCLUDED.hidden_at_fetch, fetched_at = EXCLUDED.fetched_at;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_rows := v_rows + v_n;
      UPDATE public.topshot_atlas_dists
         SET editions_total = coalesce(editions_total, nullif(v_body ->> 'totalCount', '')::integer)
       WHERE dist_id = r.dist_id;
      -- The pass is finished once a short page — or the page reaching totalCount —
      -- lands and nothing else is in flight.
      IF (jsonb_array_length(v_body -> 'editions') < 100
          OR r.offset_at + 100 >= coalesce(d.editions_total, nullif(v_body ->> 'totalCount', '')::integer, 2147483547))
         AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_pack_requests q
                          WHERE q.kind = 'editions' AND q.dist_id = r.dist_id AND q.pass = r.pass
                            AND q.drained_at IS NULL AND q.request_id <> r.request_id) THEN
        UPDATE public.topshot_atlas_dists t
           SET editions_done_at = clock_timestamp(), editions_next_offset = NULL,
               edition_rows = s.n, edition_remaining_sum = s.rem
          FROM (SELECT count(*)::integer AS n, coalesce(sum(remaining_count), 0)::bigint AS rem
                  FROM public.topshot_atlas_dist_editions e
                 WHERE e.dist_id = r.dist_id AND e.pass = r.pass) s
         WHERE t.dist_id = r.dist_id;
        -- Unreconciled (opens landed between the summary and the pages): re-read in an hour.
        UPDATE public.topshot_atlas_dists
           SET next_due_at = least(next_due_at, now() + interval '1 hour')
         WHERE dist_id = r.dist_id AND edition_remaining_sum IS DISTINCT FROM remaining_total;
      END IF;
    END IF;
    UPDATE public.topshot_atlas_pack_requests
       SET drained_at = clock_timestamp(), status_code = 200
     WHERE request_id = r.request_id;
  END LOOP;

  -- ── dispatch ─────────────────────────────────────────────────────────────
  SELECT count(*) INTO v_inflight FROM public.topshot_atlas_pack_requests WHERE drained_at IS NULL;
  -- Back off while the market lane is being challenged: this lane is optional, the
  -- market lane is not. Every DRAINED market request counts (2026-10-10): a tagged row
  -- ('__edition__…', '__verify__…') is a market request that succeeded, since a failure
  -- overwrites the tag with 'atlas 403'. Leaving tagged rows out of the denominator
  -- held this lane on ~half of all minutes while the market's real 403 rate was 13 %.
  SELECT count(*), count(*) FILTER (WHERE error LIKE 'atlas 403%')
    INTO v_market, v_market403
    FROM public.topshot_atlas_market_requests
   WHERE dispatched_at > now() - interval '10 minutes' AND drained_at IS NOT NULL;
  v_held := v_market >= 4 AND v_market403 * 2 > v_market;

  IF NOT v_held THEN
    SELECT * INTO v_state FROM public.topshot_atlas_pack_state WHERE id = 1;
    -- A new list pass daily.
    IF v_state.list_started_at IS NULL OR v_state.list_started_at < now() - interval '24 hours' THEN
      UPDATE public.topshot_atlas_pack_state
         SET list_started_at = now(), list_next_offset = 0, list_done_at = NULL
       WHERE id = 1
      RETURNING * INTO v_state;
    END IF;

    WHILE v_sent < p_budget AND v_inflight < 6 LOOP
      -- 1. the distribution list, one page at a time
      IF v_state.list_done_at IS NULL
         AND v_state.list_next_offset < coalesce(v_state.list_total, 100000) + 100
         AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_pack_requests q WHERE q.kind = 'list' AND q.drained_at IS NULL) THEN
        v_req := net.http_post(url := v_url || 'SearchDistributions',
                   body := jsonb_build_object('product', 'nba', 'limit', '100', 'offset', v_state.list_next_offset::text),
                   headers := v_headers, timeout_milliseconds := 30000);
        INSERT INTO public.topshot_atlas_pack_requests (request_id, kind, offset_at) VALUES (v_req, 'list', v_state.list_next_offset);
        UPDATE public.topshot_atlas_pack_state SET list_next_offset = list_next_offset + 100 WHERE id = 1
        RETURNING * INTO v_state;
      ELSE
        -- 2. the next edition page of a pass already under way (keeps a distribution's
        --    summary and its pages minutes apart)
        SELECT t.dist_id, t.editions_pass, t.editions_next_offset INTO d
          FROM public.topshot_atlas_dists t
         WHERE t.editions_next_offset IS NOT NULL AND t.editions_done_at IS NULL
           AND (t.editions_total IS NULL AND t.editions_next_offset = 0
                OR t.editions_total IS NOT NULL AND t.editions_next_offset < t.editions_total)
           AND NOT (t.editions_total IS NULL AND EXISTS (
                 SELECT 1 FROM public.topshot_atlas_pack_requests q
                  WHERE q.kind = 'editions' AND q.dist_id = t.dist_id AND q.pass = t.editions_pass AND q.drained_at IS NULL))
         ORDER BY t.summary_fetched_at
         LIMIT 1;
        IF d.dist_id IS NOT NULL THEN
          v_req := net.http_post(url := v_url || 'GetDistributionEditions',
                     body := jsonb_build_object('product', 'nba', 'distributionId', d.dist_id, 'limit', '100',
                                                'offset', d.editions_next_offset::text, 'hideOpened', true),
                     headers := v_headers, timeout_milliseconds := 30000);
          INSERT INTO public.topshot_atlas_pack_requests (request_id, kind, dist_id, offset_at, pass)
          VALUES (v_req, 'editions', d.dist_id, d.editions_next_offset, d.editions_pass);
          UPDATE public.topshot_atlas_dists SET editions_next_offset = editions_next_offset + 100 WHERE dist_id = d.dist_id;
        ELSE
          -- 3. the most overdue summary (never-read first, newest drops first)
          SELECT t.dist_id INTO d
            FROM public.topshot_atlas_dists t
           WHERE (t.next_due_at IS NULL OR t.next_due_at <= now())
             AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_pack_requests q
                              WHERE q.dist_id = t.dist_id AND q.drained_at IS NULL)
           ORDER BY t.next_due_at NULLS FIRST, length(t.dist_id) DESC, t.dist_id DESC
           LIMIT 1;
          EXIT WHEN d.dist_id IS NULL;
          v_req := net.http_post(url := v_url || 'GetDistributionContentSummary',
                     body := jsonb_build_object('product', 'nba', 'distributionId', d.dist_id),
                     headers := v_headers, timeout_milliseconds := 30000);
          INSERT INTO public.topshot_atlas_pack_requests (request_id, kind, dist_id) VALUES (v_req, 'summary', d.dist_id);
          UPDATE public.topshot_atlas_dists SET next_due_at = now() + interval '20 minutes' WHERE dist_id = d.dist_id;
        END IF;
      END IF;
      v_sent := v_sent + 1;
      v_inflight := v_inflight + 1;
    END LOOP;
  END IF;

  IF v_drained > 0 THEN
    PERFORM public.log_pipeline_run(
      'topshot-pack-supply-atlas', v_started, v_drained, v_rows, v_failed,
      v_failed = 0,
      CASE WHEN v_failed > 0 THEN v_failed || ' request(s) failed' END,
      'nba_top_shot', NULL, NULL,
      jsonb_build_object('drained', v_drained, 'failed', v_failed, 'rows_written', v_rows,
                         'sent', v_sent, 'held_for_market_403', v_held, 'errors_sample', v_errors));
  END IF;
  RETURN jsonb_build_object('drained', v_drained, 'failed', v_failed, 'rows_written', v_rows,
                            'sent', v_sent, 'held_for_market_403', v_held);
END;
$function$;
-- <<< END verbatim topshot_pack_supply_tick <<<

-- >>> BEGIN verbatim topshot_issuer_held_split_editions (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.topshot_issuer_held_split_editions()
 RETURNS TABLE(edition_external_id text, tier text, hidden bigint, in_packs bigint, reserve bigint,
               split_status text, pass_as_of timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
  gate AS (
    SELECT
      (SELECT list_done_at IS NOT NULL AND list_started_at > now() - interval '48 hours'
         FROM public.topshot_atlas_pack_state WHERE id = 1)                                   AS list_ok,
      count(*) FILTER (WHERE d.summary_fetched_at IS NULL)                                     AS never_read,
      count(*) FILTER (WHERE d.remaining_total > 0
                         AND (d.summary_fetched_at < now() - interval '48 hours'
                              OR d.editions_done_at IS NULL
                              OR d.edition_remaining_sum IS DISTINCT FROM d.remaining_total)) AS open_unsettled,
      min(d.summary_fetched_at) FILTER (WHERE d.remaining_total > 0)                           AS as_of
    FROM public.topshot_atlas_dists d
  ),
  submap AS (
    SELECT DISTINCT ON (e.subedition_name) e.subedition_name AS name, e.subedition_id AS id
      FROM public.editions e, ts
     WHERE e.collection_id = ts.id AND e.subedition_id IS NOT NULL AND e.subedition_name IS NOT NULL
     ORDER BY e.subedition_name, e.subedition_id
  ),
  packed AS (
    SELECT x.set_id || ':' || x.play_id
             || CASE WHEN x.parallel = 'Standard' THEN '' ELSE '::' || sm.id::text END AS external_id,
           sum(x.remaining_count)::bigint AS in_packs,
           bool_or(x.parallel <> 'Standard' AND sm.id IS NULL) AS unmapped
      FROM public.topshot_atlas_dist_editions x
      JOIN public.topshot_atlas_dists d ON d.dist_id = x.dist_id AND d.editions_pass = x.pass
      LEFT JOIN submap sm ON sm.name = x.parallel
     WHERE x.remaining_count > 0
     GROUP BY 1
  ),
  unmapped AS (SELECT count(*) AS n FROM packed WHERE unmapped OR external_id IS NULL)
  SELECT b.external_id, upper(regexp_replace(b.tier, '^MOMENT_TIER_', '')), b.hidden_in_packs::bigint,
         CASE WHEN s.ok THEN coalesce(p.in_packs, 0) END,
         CASE WHEN s.ok THEN b.hidden_in_packs - coalesce(p.in_packs, 0) END,
         s.status, g.as_of
    FROM public.badge_editions b
    CROSS JOIN ts
    CROSS JOIN gate g
    CROSS JOIN unmapped u
    LEFT JOIN packed p ON p.external_id = b.external_id
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN NOT coalesce(g.list_ok, false)        THEN 'pending: distribution list incomplete or stale'
               WHEN g.never_read > 0                      THEN 'pending: ' || g.never_read || ' distribution(s) never read'
               WHEN g.open_unsettled > 0                  THEN 'pending: ' || g.open_unsettled || ' distribution(s) with packs left not settled'
               WHEN u.n > 0                               THEN 'unknown: ' || u.n || ' packed edition(s) could not be keyed'
               WHEN b.hidden_in_packs IS NULL             THEN 'unknown: no issuer-held count'
               WHEN b.updated_at < now() - interval '36 hours' THEN 'unknown: issuer-held count is stale'
               WHEN coalesce(p.in_packs, 0) > b.hidden_in_packs THEN 'contradicted: more in packs than issuer-held'
               ELSE 'ok' END AS status
    ) st
    CROSS JOIN LATERAL (SELECT st.status AS status, st.status = 'ok' AS ok) s
   WHERE b.collection_id = ts.id;
$function$;
-- <<< END verbatim topshot_issuer_held_split_editions <<<

-- >>> BEGIN verbatim get_topshot_issuer_held_split (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_topshot_issuer_held_split()
 RETURNS TABLE(tier text, editions integer, hidden bigint, in_packs bigint, reserve bigint,
               editions_split_known integer, editions_stale integer, hidden_stale bigint,
               packs_unopened bigint, packs_owned_by_collectors bigint,
               split_status text, as_of timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
  gate AS (
    SELECT
      (SELECT list_done_at IS NOT NULL AND list_started_at > now() - interval '48 hours'
         FROM public.topshot_atlas_pack_state WHERE id = 1)                                AS list_ok,
      count(*) FILTER (WHERE d.summary_fetched_at IS NULL)                                  AS never_read,
      count(*) FILTER (WHERE d.remaining_total > 0
                         AND d.summary_fetched_at < now() - interval '48 hours')            AS stale_open,
      min(d.summary_fetched_at) FILTER (WHERE d.remaining_total > 0)                        AS as_of,
      sum(d.unopened_count)::bigint                                                         AS packs_unopened,
      sum(d.owned_count)::bigint                                                            AS packs_owned
    FROM public.topshot_atlas_dists d
  ),
  status AS (
    SELECT CASE
             WHEN NOT coalesce(g.list_ok, false) THEN 'pending: distribution list incomplete or stale'
             WHEN g.never_read > 0               THEN 'pending: ' || g.never_read || ' distribution(s) never read'
             WHEN g.stale_open > 0               THEN 'pending: ' || g.stale_open || ' distribution(s) with packs left read > 48 h ago'
             ELSE 'ok' END AS s, g.*
      FROM gate g
  ),
  packed AS (
    SELECT upper(v.key) AS tier, sum(nullif(v.value, '')::bigint)::bigint AS in_packs
      FROM public.topshot_atlas_dists d, jsonb_each_text(d.remaining_by_tier) v
     GROUP BY 1
  ),
  -- Issuer-held from rows refreshed in the last 36 h. Older rows (a handful Atlas no
  -- longer returns) are EXCLUDED and disclosed in editions_stale / hidden_stale, not
  -- silently summed and not silently dropped.
  held AS (
    SELECT upper(regexp_replace(b.tier, '^MOMENT_TIER_', '')) AS tier,
           count(*) FILTER (WHERE b.hidden_in_packs IS NOT NULL AND b.updated_at >= now() - interval '36 hours')::integer AS editions,
           sum(b.hidden_in_packs) FILTER (WHERE b.updated_at >= now() - interval '36 hours')::bigint AS hidden,
           count(*) FILTER (WHERE b.hidden_in_packs IS NULL OR b.updated_at < now() - interval '36 hours')::integer AS editions_stale,
           coalesce(sum(b.hidden_in_packs) FILTER (WHERE b.updated_at < now() - interval '36 hours'), 0)::bigint AS hidden_stale
      FROM public.badge_editions b, ts
     WHERE b.collection_id = ts.id AND b.tier IS NOT NULL
     GROUP BY 1
  ),
  known AS (
    SELECT tier, count(*) FILTER (WHERE split_status = 'ok')::integer AS n
      FROM public.topshot_issuer_held_split_editions() GROUP BY 1
  ),
  tiers AS (
    SELECT coalesce(h.tier, p.tier) AS tier, coalesce(h.editions, 0) AS editions, h.hidden,
           p.in_packs, coalesce(h.editions_stale, 0) AS editions_stale, coalesce(h.hidden_stale, 0) AS hidden_stale
      FROM held h FULL JOIN packed p ON p.tier = h.tier
     WHERE coalesce(h.hidden, 0) > 0 OR coalesce(p.in_packs, 0) > 0
  ),
  rows_ AS (
    SELECT t.tier, t.editions, t.hidden, t.in_packs, t.editions_stale, t.hidden_stale FROM tiers t
    UNION ALL
    SELECT NULL, sum(t.editions)::integer, sum(t.hidden)::bigint, sum(t.in_packs)::bigint,
           sum(t.editions_stale)::integer, sum(t.hidden_stale)::bigint FROM tiers t
  )
  SELECT r.tier, r.editions, r.hidden,
         CASE WHEN s.s = 'ok' THEN coalesce(r.in_packs, 0) END,
         CASE WHEN s.s = 'ok' AND r.hidden IS NOT NULL AND coalesce(r.in_packs, 0) <= r.hidden
              THEN r.hidden - coalesce(r.in_packs, 0) END,
         coalesce(CASE WHEN r.tier IS NULL THEN (SELECT sum(n) FROM known)::integer
                       ELSE (SELECT n FROM known k WHERE k.tier = r.tier) END, 0),
         r.editions_stale, r.hidden_stale,
         CASE WHEN r.tier IS NULL AND s.s = 'ok' THEN s.packs_unopened END,
         CASE WHEN r.tier IS NULL AND s.s = 'ok' THEN s.packs_owned END,
         CASE WHEN s.s <> 'ok' THEN s.s
              WHEN r.hidden IS NULL THEN 'unknown: no fresh issuer-held count'
              WHEN coalesce(r.in_packs, 0) > r.hidden THEN 'contradicted: more in packs than issuer-held'
              ELSE 'ok' END,
         s.as_of
    FROM rows_ r CROSS JOIN status s
   ORDER BY r.tier IS NULL, r.hidden DESC NULLS LAST;
$function$;
-- <<< END verbatim get_topshot_issuer_held_split <<<

-- ── dispatch: the list first, one page at a time, within the budget ────────
SELECT _assert_eq((SELECT topshot_pack_supply_tick(2) ->> 'sent'), '1',
  'with no drops known, only the first list page goes out (one list page in flight at a time)');
SELECT _assert_eq((SELECT url || ' ' || (body ->> 'offset') FROM net.sent),
  'https://api.production.atlas.dapperlabs.com/public/atlas.v1.DistributionService/SearchDistributions 0', 'list page 0');

-- The list answers: three drops, last page.
INSERT INTO net._http_response VALUES (9000, 200, NULL,
  '{"distributions":[{"id":"8617","title":"A","endTime":"2026-08-15T00:00:00Z","isEnabled":false,"forSaleSupply":"0","availableSupply":"0","totalSupply":"500"},{"id":"3092","title":"B","endTime":"2021-01-01T00:00:00Z","isEnabled":false,"forSaleSupply":"0","availableSupply":"0","totalSupply":"9"},{"id":"100","title":"C","endTime":"2021-01-01T00:00:00Z","isEnabled":false,"forSaleSupply":"0","availableSupply":"0","totalSupply":"5"}],"pagination":{"hasMore":false,"totalCount":"3"}}');

-- Before any summary lands, the readers publish NULL, never 0.
SELECT _assert((SELECT bool_and(in_packs IS NULL AND reserve IS NULL) FROM get_topshot_issuer_held_split()),
  'no split before the walk: NULL, not 0');

SELECT _assert_eq((SELECT (r ->> 'drained') || '/' || (r ->> 'sent') FROM (SELECT topshot_pack_supply_tick(2) r) x), '1/2',
  'the list page drains; two summaries go out');
SELECT _assert_eq((SELECT list_total || '/' || (list_done_at IS NOT NULL) FROM topshot_atlas_pack_state), '3/true', 'list complete');
SELECT _assert_eq((SELECT string_agg(body ->> 'distributionId', ',' ORDER BY id) FROM net.sent WHERE url LIKE '%Summary'),
  '8617,3092', 'never-read drops first, newest first');

-- ── summaries ───────────────────────────────────────────────────────────────
INSERT INTO net._http_response VALUES
  (9001, 200, NULL, '{"distributionId":"8617","unopenedCount":"2","remainingByTier":{"common":"5","rare":"1"},"originalCountsByTier":{"common":"1395","rare":"84"},"totalPackCount":"500","ownedCount":"2","unavailableCount":"0"}'),
  (9002, 503, NULL, 'upstream exploded');
SELECT _assert_eq((SELECT (r ->> 'drained') || '/' || (r ->> 'failed') FROM (SELECT topshot_pack_supply_tick(2) r) x), '2/1',
  'two summaries drained, one failed');
SELECT _assert_eq((SELECT remaining_total || '/' || unopened_count || '/' || editions_next_offset || '/' || (summary_fetched_at IS NOT NULL)
                     FROM topshot_atlas_dists WHERE dist_id = '8617'), '6/2/100/true',
  'the 200 writes counts and opens an edition pass (page 0 already sent this tick)');
SELECT _assert((SELECT summary_fetched_at IS NULL AND next_due_at > now() + interval '25 minutes' AND attempts = 1
                  FROM topshot_atlas_dists WHERE dist_id = '3092'),
  'a failed summary moves next_due_at and never the KNOW-stamp');
SELECT _assert_eq((SELECT pipeline || '/' || ok FROM pipeline_log ORDER BY ctid DESC LIMIT 1), 'topshot-pack-supply-atlas/false',
  'a tick with a failed request is NOT ok');
SELECT _assert_eq((SELECT string_agg((body ->> 'distributionId') || ':' || (body ->> 'offset') || ':' || (body ->> 'hideOpened'), ',' ORDER BY id)
                     FROM net.sent WHERE url LIKE '%Editions'), '8617:0:true',
  'the edition page of an open pass goes before any other summary, with hideOpened');

-- ── edition pages ───────────────────────────────────────────────────────────
-- 9003 = editions page 0 of 8617, 9004 = summary of drop 100 (sent in the same tick).
INSERT INTO net._http_response VALUES
  (9003, 200, NULL, '{"editions":[{"editionId":"e1","originalCount":"10","remainingCount":"4","edition":{"id":"e1","setId":"261","editionTemplateId":"8705","parallel":"Standard","tier":"COMMON","numHiddenInPacks":"50"}},{"editionId":"e2","originalCount":"5","remainingCount":"1","edition":{"id":"e2","setId":"261","editionTemplateId":"8706","parallel":"Standard","tier":"COMMON","numHiddenInPacks":"1"}},{"editionId":"e3","originalCount":"3","remainingCount":"1","edition":{"id":"e3","setId":"261","editionTemplateId":"8707","parallel":"Bit","tier":"MOMENT_TIER_RARE","numHiddenInPacks":"3"}}],"totalCount":"3"}'),
  (9004, 200, NULL, '{"distributionId":"100","unopenedCount":"0","remainingByTier":{"common":"0"},"originalCountsByTier":{"common":"5"},"totalPackCount":"5","ownedCount":"0","unavailableCount":"0"}');
SELECT topshot_pack_supply_tick(2);
SELECT _assert_eq((SELECT edition_rows || '/' || edition_remaining_sum || '/' || (editions_done_at IS NOT NULL) || '/' || remaining_total
                     FROM topshot_atlas_dists WHERE dist_id = '8617'), '3/6/true/6',
  'the pass closes on the page reaching totalCount and reconciles to remainingByTier');
SELECT _assert_eq((SELECT tier || '/' || parallel FROM topshot_atlas_dist_editions WHERE atlas_edition_id = 'e3'), 'RARE/Bit',
  'tier normalised, parallel kept');
SELECT _assert((SELECT next_due_at > now() + interval '29 days' AND edition_rows = 0 AND editions_done_at IS NOT NULL
                  FROM topshot_atlas_dists WHERE dist_id = '100'),
  'a fully-opened, closed drop is settled with no edition pass and re-checked in 30 days');
SELECT _assert((SELECT next_due_at BETWEEN now() + interval '19 hours' AND now() + interval '21 hours'
                  FROM topshot_atlas_dists WHERE dist_id = '8617'),
  'a drop with packs left is re-read daily');

-- A page from a superseded pass is recorded, not written.
INSERT INTO topshot_atlas_pack_requests (request_id, kind, dist_id, offset_at, pass, dispatched_at) VALUES (5, 'editions', '8617', 0, 1, now());
INSERT INTO net._http_response VALUES (5, 200, NULL, '{"editions":[{"editionId":"zz","originalCount":"1","remainingCount":"1","edition":{"setId":"1","editionTemplateId":"1","tier":"COMMON"}}],"totalCount":"1"}');
SELECT topshot_pack_supply_tick(0);
SELECT _assert((SELECT error = '__superseded__' FROM topshot_atlas_pack_requests WHERE request_id = 5)
               AND NOT EXISTS (SELECT 1 FROM topshot_atlas_dist_editions WHERE atlas_edition_id = 'zz'),
  'a superseded page is recorded and not written');

-- A request with no response past 15 minutes fails.
INSERT INTO topshot_atlas_pack_requests (request_id, kind, dist_id, dispatched_at) VALUES (6, 'summary', '3092', now() - interval '20 minutes');
SELECT topshot_pack_supply_tick(0);
SELECT _assert_eq((SELECT error FROM topshot_atlas_pack_requests WHERE request_id = 6), 'no-response', 'a lost request fails as no-response');

-- ── readers: still pending while 3092 has never been read ──────────────────
INSERT INTO public.badge_editions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '261:8705',    'COMMON',             50,  now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '261:8706',    'COMMON',             1,   now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '261:8707::9', 'RARE',               3,   now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '261:9999',    'MOMENT_TIER_COMMON', 20,  now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '258:9239',    'COMMON',             700, now() - interval '10 days');
SELECT _assert_eq((SELECT split_status FROM get_topshot_issuer_held_split() WHERE tier IS NULL), 'pending: 1 distribution(s) never read',
  'one unread drop holds the whole split back');
SELECT _assert((SELECT bool_and(in_packs IS NULL AND reserve IS NULL) FROM topshot_issuer_held_split_editions()),
  'per-edition is NULL while pending');

-- 3092 is read: nothing left, closed.
UPDATE topshot_atlas_dists SET summary_fetched_at = now(), summary_pass = 77, editions_pass = 77, remaining_by_tier = '{"common":"0"}',
       remaining_total = 0, unopened_count = 0, owned_count = 0, editions_done_at = now(), edition_rows = 0, edition_remaining_sum = 0
 WHERE dist_id = '3092';

SELECT _assert_eq((SELECT in_packs || '/' || reserve || '/' || split_status FROM topshot_issuer_held_split_editions() WHERE edition_external_id = '261:8705'),
  '4/46/ok', 'per edition: reserve = hidden − Σ remaining in current passes');
SELECT _assert_eq((SELECT in_packs || '/' || reserve FROM topshot_issuer_held_split_editions() WHERE edition_external_id = '261:8707::9'),
  '1/2', 'a parallel keys through the subedition map');
SELECT _assert_eq((SELECT in_packs || '/' || reserve FROM topshot_issuer_held_split_editions() WHERE edition_external_id = '261:9999'),
  '0/20', 'an edition in no pack is all reserve');
SELECT _assert((SELECT in_packs IS NULL AND split_status = 'unknown: issuer-held count is stale' FROM topshot_issuer_held_split_editions() WHERE edition_external_id = '258:9239'),
  'a stale issuer-held count is unknown, not split');

SELECT _assert_eq((SELECT hidden || '/' || in_packs || '/' || reserve || '/' || editions_stale || '/' || hidden_stale || '/' || split_status
                     FROM get_topshot_issuer_held_split() WHERE tier = 'COMMON'),
  '71/5/66/1/700/ok', 'per tier: fresh hidden − Σ remainingByTier; the stale row is excluded AND disclosed');
SELECT _assert_eq((SELECT hidden || '/' || in_packs || '/' || reserve || '/' || packs_unopened || '/' || packs_owned_by_collectors
                     FROM get_topshot_issuer_held_split() WHERE tier IS NULL),
  '74/6/68/2/2', 'the collection row sums the tiers and carries pack counts');

-- More in packs than issuer-held is contradicted, never a negative reserve.
UPDATE public.badge_editions SET hidden_in_packs = 3 WHERE external_id = '261:8705';
SELECT _assert((SELECT reserve IS NULL AND split_status = 'contradicted: more in packs than issuer-held'
                  FROM topshot_issuer_held_split_editions() WHERE edition_external_id = '261:8705'),
  'per edition: contradicted, not negative');
UPDATE public.badge_editions SET hidden_in_packs = 50 WHERE external_id = '261:8705';

-- An unreconciled drop with packs left holds the per-edition split, not the tier split.
UPDATE topshot_atlas_dists SET edition_remaining_sum = 5 WHERE dist_id = '8617';
SELECT _assert_eq((SELECT split_status FROM topshot_issuer_held_split_editions() WHERE edition_external_id = '261:8705'),
  'pending: 1 distribution(s) with packs left not settled', 'per edition waits for an exact reconcile');
SELECT _assert_eq((SELECT split_status FROM get_topshot_issuer_held_split() WHERE tier = 'COMMON'), 'ok',
  'the tier split (summaries) does not need the edition reconcile');
UPDATE topshot_atlas_dists SET edition_remaining_sum = 6 WHERE dist_id = '8617';

-- A drop with packs left read > 48 h ago makes everything pending again.
UPDATE topshot_atlas_dists SET summary_fetched_at = now() - interval '49 hours' WHERE dist_id = '8617';
SELECT _assert((SELECT bool_and(reserve IS NULL) FROM get_topshot_issuer_held_split()), 'stale open drop: no tier split');
UPDATE topshot_atlas_dists SET summary_fetched_at = now() WHERE dist_id = '8617';

-- ── back-off ─────────────────────────────────────────────────────────────────
UPDATE topshot_atlas_dists SET next_due_at = now() - interval '1 minute' WHERE dist_id = '3092';
INSERT INTO public.topshot_atlas_market_requests
SELECT g, now() - interval '1 minute', CASE WHEN g % 4 = 0 THEN NULL ELSE 'atlas 403 (): <!DOCTYPE html>' END, now() FROM generate_series(1, 8) g;
SELECT _assert_eq((SELECT (r ->> 'sent') || '/' || (r ->> 'held_for_market_403') FROM (SELECT topshot_pack_supply_tick(2) r) x), '0/true',
  'nothing is sent while the market lane is mostly 403s');
TRUNCATE public.topshot_atlas_market_requests;
-- The market lane's successes carry a tag ('__edition__…'); a failure overwrites it with
-- 'atlas 403'. 4 failures in 12 drained requests is not a challenge (counting only the
-- untagged rows read it as 4 of 6 and held).
INSERT INTO public.topshot_atlas_market_requests
SELECT g, now() - interval '1 minute',
       CASE WHEN g <= 4 THEN 'atlas 403 (): <!DOCTYPE html>' WHEN g <= 6 THEN NULL ELSE '__edition__' || g END,
       now()
  FROM generate_series(1, 12) g;
SELECT _assert_eq((SELECT (r ->> 'held_for_market_403') FROM (SELECT topshot_pack_supply_tick(0) r) x), 'false',
  'tagged market rows are successes: 4 of 12 drained is no challenge');
TRUNCATE public.topshot_atlas_market_requests;
-- In-flight rows have no outcome yet: 4 failures among 4 drained IS a challenge.
INSERT INTO public.topshot_atlas_market_requests
SELECT g, now() - interval '1 minute', CASE WHEN g <= 4 THEN 'atlas 403 (): <!DOCTYPE html>' END,
       CASE WHEN g <= 4 THEN now() END
  FROM generate_series(1, 8) g;
SELECT _assert_eq((SELECT (r ->> 'held_for_market_403') FROM (SELECT topshot_pack_supply_tick(0) r) x), 'true',
  'in-flight market rows count on neither side');
TRUNCATE public.topshot_atlas_market_requests;
SELECT _assert_eq((SELECT topshot_pack_supply_tick(2) ->> 'sent'), '1', 'once it clears, the due summary goes out');

-- ── an unchanged summary keeps its reconciled pass ─────────────────────────
-- 8617 is settled under pass 9001 (remaining {"common":"5","rare":"1"}, 3 rows, sum 6).
INSERT INTO topshot_atlas_pack_requests (request_id, kind, dist_id, dispatched_at) VALUES (7, 'summary', '8617', now());
INSERT INTO net._http_response VALUES (7, 200, NULL,
  '{"distributionId":"8617","unopenedCount":"2","remainingByTier":{"rare":"1","common":"5"},"originalCountsByTier":{"common":"1395","rare":"84"},"totalPackCount":"500","ownedCount":"2","unavailableCount":"0"}');
SELECT topshot_pack_supply_tick(0);
SELECT _assert_eq((SELECT summary_pass || '/' || editions_pass || '/' || (editions_done_at IS NOT NULL) || '/' || edition_rows || '/' || edition_remaining_sum
                          || '/' || coalesce(editions_next_offset::text, 'null')
                     FROM topshot_atlas_dists WHERE dist_id = '8617'), '7/9001/true/3/6/null',
  'unchanged counts: the new summary is recorded and the reconciled pass is carried forward');
SELECT _assert((SELECT next_due_at BETWEEN now() + interval '39 hours' AND now() + interval '41 hours'
                  FROM topshot_atlas_dists WHERE dist_id = '8617'),
  'an unchanged drop is re-read in 40 h');
SELECT _assert_eq((SELECT in_packs || '/' || split_status FROM topshot_issuer_held_split_editions() WHERE edition_external_id = '261:8705'),
  '4/ok', 'the carried pass still settles the per-edition split');

-- A changed summary opens a new pass.
INSERT INTO topshot_atlas_pack_requests (request_id, kind, dist_id, dispatched_at) VALUES (8, 'summary', '8617', now());
INSERT INTO net._http_response VALUES (8, 200, NULL,
  '{"distributionId":"8617","unopenedCount":"2","remainingByTier":{"common":"4","rare":"1"},"originalCountsByTier":{"common":"1395","rare":"84"},"totalPackCount":"500","ownedCount":"2","unavailableCount":"0"}');
SELECT topshot_pack_supply_tick(0);
SELECT _assert_eq((SELECT editions_pass || '/' || (editions_done_at IS NULL) || '/' || editions_next_offset || '/' || remaining_total
                     FROM topshot_atlas_dists WHERE dist_id = '8617'), '8/true/0/5',
  'changed counts: a new pass opens');
SELECT _assert((SELECT next_due_at BETWEEN now() + interval '19 hours' AND now() + interval '21 hours'
                  FROM topshot_atlas_dists WHERE dist_id = '8617'),
  'a changed drop is re-read daily');
SELECT _assert_eq((SELECT split_status FROM topshot_issuer_held_split_editions() WHERE edition_external_id = '261:8705'),
  'pending: 1 distribution(s) with packs left not settled', 'the new pass must settle before the split publishes');

SELECT '✓ topshot_pack_supply_tick + issuer-held split readers: all assertions passed' AS result;

ROLLBACK;
