-- audit_20261010_topshot_pack_supply_carries_unchanged_passes_and_counts_tagged_market_rows
--
-- Why: the Top Shot issuer-held split (/insights/market-cap panel, edition-page tile)
-- has read "pending" every day since the lane started on 10-03, and could never pass its
-- own gate (every drop with packs left read < 48 h ago and reconciled).
--
-- Measured 2026-10-10 ~2:30 PM PT:
--   · 3,270 drops have packs left; each was re-read every 20 h with ALL its edition
--     pages (~970 summaries + ~970 pages a day). Only 126 of them had an on-chain open
--     in 3 days, so nearly every re-read returned the same counts.
--   · capacity is 2 requests a minute, but 441 of 1,440 minutes sent nothing: the
--     market-403 back-off counted only UNTAGGED market rows. Tagged rows
--     ('__edition__…', '__verify__…') are the market lane's SUCCESSES; a failure overwrites
--     the tag with 'atlas 403'. Replayed over 23 h, the old rule held on 671 of 1,380
--     minutes; counting every drained row, 2. The market lane's real 403 rate: 13.4 %.
--   · result: 2,891 summaries overdue, 300 drops never read, the gate unreachable.
--
-- Change (topshot_pack_supply_tick only; readers untouched):
--   1. the back-off counts every DRAINED market request (in-flight rows count on neither
--      side);
--   2. a summary whose per-tier counts equal the stored ones, under a pass that
--      reconciled exactly, carries that pass forward (no edition pages) and is re-read
--      in 40 h. Opens only lower a tier's count, so equal counts mean no opens. A changed
--      summary opens a new pass and is re-read in 20 h, as before.
--
-- Pin: supabase/tests/topshot_pack_supply_tick.sql (planted defects: the old back-off,
-- counting in-flight rows, v_same forced false, v_same forced true: each red).
--
-- anon-exec: unchanged (topshot_pack_supply_tick) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified anon=false, authenticated=false 2026-10-10.
--
-- Revert: re-apply the topshot_pack_supply_tick block from
-- 20261003224608_audit_20261003_topshot_pack_supply_from_atlas_distribution_service.sql.

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
