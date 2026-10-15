-- audit_20261014_issuer_held_split_survives_the_daily_list_rewalk
--
-- The Top Shot issuer-held split ("inside packs vs reserve" on /insights/market-cap and
-- the edition-page tile) read "pending: distribution list incomplete or stale" for the
-- whole of every daily list re-walk (~4:17 -> ~5:30 PM PT on 10-14, ~54 pages one at a
-- time), even though the previous, complete list was a day old. Cause: the tick started
-- each new pass with `list_done_at = NULL`, and the three readers gated on
-- `list_done_at IS NOT NULL AND list_started_at > now() - 48h` -- so a refresh IN
-- PROGRESS unpublished a split whose inputs were all valid. Measured 10-14 ~5:15 PM PT:
-- 0 never-read and 0 stale of 3,513 open drops; the list gate was the only one failing.
--
-- Fix:
--   * writer  topshot_pack_supply_tick: a new pass keeps list_done_at (the LAST COMPLETED
--             list); a walk is in progress while list_done_at < list_started_at.
--   * readers topshot_issuer_held_split_editions, get_topshot_issuer_held_split,
--             get_topshot_issuer_held_split_edition: gate on `list_done_at > now() - 48h`
--             -- the last completed list is fresh. Exactly as strict against a stalled
--             walk as before (a recent list_started_at no longer counts for anything).
--
-- Pins: supabase/tests/topshot_pack_supply_tick.sql (+3 reader blocks),
--       supabase/tests/get_topshot_issuer_held_split_edition.sql; each new assertion
--       proven to red on the old writer / old reader.
--
-- REVERT: re-apply the previous bodies, verbatim, from
--   20261010213401_audit_20261010_topshot_pack_supply_carries_unchanged_passes_and_counts_tagged_market_rows.sql (topshot_pack_supply_tick)
--   20261003224608_audit_20261003_topshot_pack_supply_from_atlas_distribution_service.sql (topshot_issuer_held_split_editions, get_topshot_issuer_held_split)
--   20261003232935_audit_20261003_topshot_issuer_held_split_one_edition.sql (get_topshot_issuer_held_split_edition)
-- and move the four db-invariants-drift-guard registrations back.
--
-- anon-exec: unchanged (topshot_pack_supply_tick) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false 10-14.
-- anon-exec: unchanged (topshot_issuer_held_split_editions) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false 10-14.
-- anon-exec: unchanged (get_topshot_issuer_held_split) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false 10-14.
-- anon-exec: unchanged (get_topshot_issuer_held_split_edition) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false 10-14.

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
    -- A new list pass daily. It keeps list_done_at: that stamp is the LAST COMPLETED
    -- list, which the readers gate on, and a refresh in progress does not make it
    -- wrong (2026-10-14: nulling it read "pending" for the ~75 min of every walk).
    -- A walk is in progress while list_done_at < list_started_at.
    IF v_state.list_started_at IS NULL OR v_state.list_started_at < now() - interval '24 hours' THEN
      UPDATE public.topshot_atlas_pack_state
         SET list_started_at = now(), list_next_offset = 0
       WHERE id = 1
      RETURNING * INTO v_state;
    END IF;

    WHILE v_sent < p_budget AND v_inflight < 6 LOOP
      -- 1. the distribution list, one page at a time
      IF (v_state.list_done_at IS NULL OR v_state.list_done_at < v_state.list_started_at)
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
      (SELECT list_done_at > now() - interval '48 hours'
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
      (SELECT list_done_at > now() - interval '48 hours'
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

CREATE OR REPLACE FUNCTION public.get_topshot_issuer_held_split_edition(p_external_id text)
 RETURNS TABLE(edition_external_id text, hidden bigint, in_packs bigint, reserve bigint,
               drops_with_packs integer, split_status text, as_of timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
  b AS (
    SELECT be.external_id, be.hidden_in_packs, be.updated_at,
           nullif(split_part(be.external_id, ':', 1), '')::integer AS set_id,
           nullif(split_part(be.external_id, ':', 2), '')::integer AS play_id,
           nullif(split_part(be.external_id, '::', 2), '')::integer AS sub_id
      FROM public.badge_editions be, ts
     WHERE be.collection_id = ts.id AND be.external_id = p_external_id
       AND be.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ),
  gate AS (
    SELECT
      (SELECT list_done_at > now() - interval '48 hours'
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
  rows_ AS (
    SELECT x.dist_id, x.remaining_count, x.parallel, sm.id AS sub_id
      FROM b
      JOIN public.topshot_atlas_dist_editions x ON x.set_id = b.set_id AND x.play_id = b.play_id
      JOIN public.topshot_atlas_dists d ON d.dist_id = x.dist_id AND d.editions_pass = x.pass
      LEFT JOIN submap sm ON sm.name = x.parallel
     WHERE x.remaining_count > 0
  ),
  -- Only this printing's rows count; a packed parallel of the same play that cannot
  -- be keyed MIGHT be this printing, so it makes the split unknown rather than
  -- being silently dropped or added.
  packed AS (
    SELECT sum(r.remaining_count) FILTER (WHERE (b.sub_id IS NULL AND r.parallel = 'Standard')
                                             OR (b.sub_id IS NOT NULL AND r.sub_id = b.sub_id))::bigint AS in_packs,
           count(DISTINCT r.dist_id) FILTER (WHERE (b.sub_id IS NULL AND r.parallel = 'Standard')
                                                OR (b.sub_id IS NOT NULL AND r.sub_id = b.sub_id))::integer AS drops,
           bool_or(r.parallel <> 'Standard' AND r.sub_id IS NULL) AS unmapped
      FROM rows_ r, b
  )
  SELECT b.external_id, b.hidden_in_packs::bigint,
         CASE WHEN st.status = 'ok' THEN coalesce(p.in_packs, 0) END,
         CASE WHEN st.status = 'ok' THEN b.hidden_in_packs - coalesce(p.in_packs, 0) END,
         CASE WHEN st.status = 'ok' THEN coalesce(p.drops, 0) END,
         st.status, g.as_of
    FROM b CROSS JOIN gate g LEFT JOIN packed p ON true
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN NOT coalesce(g.list_ok, false)        THEN 'pending: distribution list incomplete or stale'
               WHEN g.never_read > 0                      THEN 'pending: ' || g.never_read || ' distribution(s) never read'
               WHEN g.open_unsettled > 0                  THEN 'pending: ' || g.open_unsettled || ' distribution(s) with packs left not settled'
               WHEN coalesce(p.unmapped, false)           THEN 'unknown: a packed parallel of this play could not be keyed'
               WHEN b.hidden_in_packs IS NULL             THEN 'unknown: no issuer-held count'
               WHEN b.updated_at < now() - interval '36 hours' THEN 'unknown: issuer-held count is stale'
               WHEN coalesce(p.in_packs, 0) > b.hidden_in_packs THEN 'contradicted: more in packs than issuer-held'
               ELSE 'ok' END AS status
    ) st;
$function$;
