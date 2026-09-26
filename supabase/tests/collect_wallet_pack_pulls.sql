-- DB invariant: public.collect_wallet_pack_pulls — prices every pack a saved
-- wallet opened from the exact moments Dapper's index says it yielded
-- (searchPackNft.nfts), added 2026-09-26 for "pull value should be filled for
-- every ripped pack" (Trevor). Claims it must keep:
--
--   1. The pull list is Dapper's `nfts` for OPENED packs only, one row per
--      (collection, pack, moment); a Sealed pack or an unknown pack type adds
--      nothing.
--   2. Editions resolve from what we hold, COLLECTION-SCOPED (a moment id is
--      unique only within a collection): a Top Shot `moments` row with the same
--      id never names an All Day pull.
--   3. WHOLE-PACK, ALL-OR-NOTHING: pull_value_usd is the sum of current FMV only
--      when every pull is priced. A partial sum is never published, and an FMV
--      of 0 is "unpriced", so a pack never reads $0 for "unknown".
--   4. An unnamed All Day pull is looked up in Dapper's index (searchAllDayNft,
--      id IN [...]); the answer names it and the pack is repriced.
--   5. A failed page ends the walk WITH an error and ok=false; a page with a
--      next page dispatches it and does NOT mark the walk complete.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926153000_audit_20260926_wallet_pack_pulls_named_by_dapper_index_so_every_rip_can_be_priced.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text UNIQUE, name text);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.moments (nft_id text, collection_id uuid, edition_id uuid);
CREATE TABLE public.allday_pack_pull (pack_nft_id text, moment_nft_id text, edition_id uuid);
CREATE TABLE public.golazos_pack_open_pulls (nft_id text PRIMARY KEY, pack_nft_id text, edition_external_id text);
CREATE TABLE public.wallet_moments_cache (wallet_address text, moment_id text, collection_id uuid, edition_key text);
CREATE TABLE public.fmv_snapshots (collection_id uuid, edition_id uuid, fmv_usd numeric, computed_at timestamptz);
CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;

-- pg_net stand-in: http_post records the call and returns an id; responses are
-- planted into net._http_response by the test.
CREATE SCHEMA net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text);
CREATE SEQUENCE net.req_seq START 1000;
CREATE TABLE net.calls (id bigint, body jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('net.req_seq');
BEGIN INSERT INTO net.calls VALUES (v, body); RETURN v; END $$;

-- the lane's own tables, as the migration creates them
CREATE TABLE public.pack_open_pulls (
  collection_id uuid NOT NULL, pack_nft_id text NOT NULL, nft_id text NOT NULL, opener_address text NOT NULL,
  edition_id uuid, resolved_via text, resolved_at timestamptz, local_checked_at timestamptz,
  api_attempts int NOT NULL DEFAULT 0, api_checked_at timestamptz, first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, pack_nft_id, nft_id));
CREATE TABLE public.pack_open_pull_values (
  collection_id uuid NOT NULL, pack_nft_id text NOT NULL, opener_address text NOT NULL,
  n_pulls int NOT NULL, n_resolved int NOT NULL, n_priced int NOT NULL, pull_value_usd numeric(14,2),
  priced_at timestamptz NOT NULL, PRIMARY KEY (collection_id, pack_nft_id),
  CONSTRAINT pack_open_pull_values_whole_pack CHECK (pull_value_usd IS NULL OR n_priced = n_pulls));
CREATE TABLE public.pack_pull_wallet_state (
  wallet text PRIMARY KEY, requested_at timestamptz, completed_at timestamptz,
  pages int NOT NULL DEFAULT 0, packs int NOT NULL DEFAULT 0, pulls int NOT NULL DEFAULT 0, last_error text);
CREATE TABLE public.pack_pull_requests (
  request_id bigint PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('wallet', 'editions')), wallet text,
  collection_id uuid, nft_ids text[] NOT NULL DEFAULT '{}', after_cursor text, page int,
  dispatched_at timestamptz NOT NULL DEFAULT now(), collected_at timestamptz, status_code int, outcome text, n_returned int);

-- >>> BEGIN verbatim collect_wallet_pack_pulls (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.collect_wallet_pack_pulls()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts uuid; v_ad uuid; v_gz uuid;
  r record;
  v_body jsonb;
  v_edges jsonb;
  v_n int;
  v_next bigint;
  v_requests int := 0; v_ok int := 0; v_failed int := 0; v_expired int := 0;
  v_pages int := 0; v_wallets_done int := 0;
  v_pulls_new int := 0; v_api_named int := 0; v_local_named int := 0;
  v_lookups int := 0; v_priced_packs int := 0; v_valued_packs int := 0;
  v_last_error text := NULL;
  v_touched_packs text[] := '{}';
  b record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('collect_wallet_pack_pulls')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another collector holds the lock');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';

  -- (1) Collect every landed request.
  FOR r IN
    SELECT q.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error,
           (h.id IS NOT NULL) AS landed
    FROM public.pack_pull_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
    ORDER BY q.dispatched_at
  LOOP
    v_requests := v_requests + 1;

    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '2 hours' THEN
        UPDATE public.pack_pull_requests SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        v_expired := v_expired + 1;
        IF r.kind = 'wallet' THEN
          UPDATE public.pack_pull_wallet_state
             SET completed_at = now(), last_error = 'no_response on page ' || coalesce(r.page, 1)
           WHERE wallet = r.wallet AND completed_at IS NULL;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb')
                   THEN r.h_content::jsonb END;
    v_edges := CASE r.kind
                 WHEN 'wallet' THEN v_body->'data'->'searchPackNft'->'edges'
                 ELSE coalesce(v_body->'data'->'searchAllDayNft'->'edges',
                               v_body->'data'->'searchGolazosNft'->'edges')
               END;

    IF v_body IS NULL OR jsonb_typeof(v_edges) IS DISTINCT FROM 'array' THEN
      v_failed := v_failed + 1;
      v_last_error := left(coalesce(v_body->'errors'->0->>'message', r.h_error, r.h_content, 'http ' || r.h_status), 200);
      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = r.h_status,
             outcome = CASE WHEN r.h_status IS DISTINCT FROM 200 THEN 'http_' || coalesce(r.h_status::text, 'null')
                            WHEN v_body ? 'errors' THEN 'graphql_error' ELSE 'undecodable' END
       WHERE request_id = r.request_id;
      IF r.kind = 'wallet' THEN
        UPDATE public.pack_pull_wallet_state
           SET completed_at = now(), last_error = 'page ' || coalesce(r.page, 1) || ': ' || v_last_error
         WHERE wallet = r.wallet AND completed_at IS NULL;
      END IF;
      CONTINUE;
    END IF;

    IF r.kind = 'wallet' THEN
      -- "A.<addr>.<Contract>.<id>" per pulled moment; the collection is the
      -- PACK's contract (a pack only ever yields its own collection's moments).
      WITH ins AS (
        INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address)
        SELECT DISTINCT
               CASE e->'node'->>'type_name'
                 WHEN 'A.0b2a3299cc857e29.PackNFT.NFT' THEN v_ts
                 WHEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' THEN v_ad
                 WHEN 'A.87ca73a41bb50ad5.PackNFT.NFT' THEN v_gz
               END,
               e->'node'->>'id',
               split_part(t.tok, '.', 4),
               r.wallet
        FROM jsonb_array_elements(v_edges) e
        CROSS JOIN LATERAL regexp_split_to_table(coalesce(e->'node'->>'nfts', ''), '\s*,\s*') AS t(tok)
        WHERE e->'node'->>'status' = 'Opened'
          AND e->'node'->>'id' IS NOT NULL
          AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT', 'A.87ca73a41bb50ad5.PackNFT.NFT')
          AND t.tok ~ '^A\.[0-9a-f]+\.[A-Za-z]+\.[0-9]+$'
        ON CONFLICT (collection_id, pack_nft_id, nft_id) DO NOTHING
        RETURNING pack_nft_id
      )
      SELECT count(*), coalesce(array_agg(DISTINCT pack_nft_id), '{}') INTO v_n, v_touched_packs FROM ins;
      v_pulls_new := v_pulls_new + v_n;

      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = 200, outcome = 'ok', n_returned = jsonb_array_length(v_edges)
       WHERE request_id = r.request_id;
      v_ok := v_ok + 1;
      v_pages := v_pages + 1;

      UPDATE public.pack_pull_wallet_state s
         SET pages = s.pages + 1,
             packs = s.packs + jsonb_array_length(v_edges),
             pulls = (SELECT count(*) FROM public.pack_open_pulls p WHERE p.opener_address = r.wallet)
       WHERE s.wallet = r.wallet;

      -- Three outcomes; only the first two END the walk. A next page already
      -- in flight is "still walking", never "done".
      IF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL) THEN
        UPDATE public.pack_pull_wallet_state SET completed_at = now(), last_error = NULL WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF coalesce(r.page, 1) >= 20 THEN
        UPDATE public.pack_pull_wallet_state
           SET completed_at = now(), last_error = 'page cap 20 reached; opened packs beyond 20,000 not walked'
         WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF NOT EXISTS (SELECT 1 FROM public.pack_pull_requests d
                         WHERE d.kind = 'wallet' AND d.wallet = r.wallet
                           AND d.after_cursor = v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor'
                           AND d.collected_at IS NULL) THEN
        SELECT net.http_post(
          url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
          body := jsonb_build_object(
            'query', 'query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ totalCount pageInfo{ endCursor hasNextPage } edges{ node{ id type_name status nfts } } } }',
            'variables', jsonb_build_object('i', jsonb_build_object(
              'first', 1000,
              'after', v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor',
              'filters', jsonb_build_array(
                jsonb_build_object('owner_address', jsonb_build_object('eq', substr(r.wallet, 3))),
                jsonb_build_object('status', jsonb_build_object('eq', 'Opened')))
            ))
          ),
          headers := '{"Content-Type":"application/json","Origin":"https://nbatopshot.com","Referer":"https://nbatopshot.com/","User-Agent":"RipPacksCity/1.0"}'::jsonb,
          timeout_milliseconds := 30000
        ) INTO v_next;
        INSERT INTO public.pack_pull_requests (request_id, kind, wallet, after_cursor, page)
        VALUES (v_next, 'wallet', r.wallet, v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor', coalesce(r.page, 1) + 1);
      END IF;

    ELSE
      -- edition lookup: node.edition.id is the collection's on-chain edition id,
      -- which is editions.external_id for All Day and Golazos.
      WITH named AS (
        UPDATE public.pack_open_pulls p
           SET edition_id = ed.id, resolved_via = 'studio_api', resolved_at = now()
          FROM jsonb_array_elements(v_edges) e
          JOIN public.editions ed
            ON ed.collection_id = r.collection_id
           AND ed.external_id = e->'node'->'edition'->>'id'
         WHERE p.collection_id = r.collection_id
           AND p.nft_id = e->'node'->>'id'
           AND p.edition_id IS NULL
        RETURNING p.pack_nft_id
      )
      SELECT count(*), coalesce(array_agg(DISTINCT pack_nft_id), '{}')
        INTO v_n, v_touched_packs FROM named;
      v_api_named := v_api_named + v_n;

      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = 200, outcome = 'ok', n_returned = jsonb_array_length(v_edges)
       WHERE request_id = r.request_id;
      v_ok := v_ok + 1;
    END IF;

    -- packs whose inputs changed this tick are repriced below
    IF cardinality(v_touched_packs) > 0 THEN
      UPDATE public.pack_open_pull_values SET priced_at = '-infinity'
       WHERE pack_nft_id = ANY (v_touched_packs);
      INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, pull_value_usd, priced_at)
      SELECT DISTINCT ON (p.collection_id, p.pack_nft_id) p.collection_id, p.pack_nft_id, p.opener_address, 0, 0, 0, NULL, '-infinity'
        FROM public.pack_open_pulls p WHERE p.pack_nft_id = ANY (v_touched_packs)
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
    END IF;
  END LOOP;

  -- (2) Resolve editions from what we already hold. Oldest-checked first, stamped
  -- with clock_timestamp() so an unresolvable row rotates to the back instead of
  -- re-occupying the head every tick. moment ids are unique only WITHIN a
  -- collection, so every probe is collection-scoped.
  WITH cand AS MATERIALIZED (
    SELECT p.collection_id, p.pack_nft_id, p.nft_id
    FROM public.pack_open_pulls p
    WHERE p.edition_id IS NULL
    ORDER BY p.local_checked_at NULLS FIRST
    LIMIT 4000
  ), found AS (
    SELECT c.*, coalesce(m.edition_id, ap.edition_id, gz.id, wm.id) AS edition_id,
           CASE WHEN m.edition_id IS NOT NULL THEN 'moments'
                WHEN ap.edition_id IS NOT NULL THEN 'allday_pack_pull'
                WHEN gz.id IS NOT NULL THEN 'golazos_pack_open_pulls'
                WHEN wm.id IS NOT NULL THEN 'wallet_moments_cache' END AS via
    FROM cand c
    LEFT JOIN LATERAL (
      SELECT mo.edition_id FROM public.moments mo
       WHERE mo.nft_id = c.nft_id AND mo.collection_id = c.collection_id AND mo.edition_id IS NOT NULL
       LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT a.edition_id FROM public.allday_pack_pull a
       WHERE c.collection_id = v_ad AND a.pack_nft_id = c.pack_nft_id AND a.moment_nft_id = c.nft_id
         AND a.edition_id IS NOT NULL
       LIMIT 1
    ) ap ON true
    LEFT JOIN LATERAL (
      SELECT ed.id FROM public.golazos_pack_open_pulls g
        JOIN public.editions ed ON ed.collection_id = v_gz AND ed.external_id = g.edition_external_id
       WHERE c.collection_id = v_gz AND g.nft_id = c.nft_id
       LIMIT 1
    ) gz ON true
    LEFT JOIN LATERAL (
      SELECT ed.id FROM public.wallet_moments_cache w
        JOIN public.editions ed ON ed.collection_id = w.collection_id AND ed.external_id = w.edition_key
       WHERE w.moment_id = c.nft_id AND w.collection_id = c.collection_id AND w.edition_key IS NOT NULL
       LIMIT 1
    ) wm ON true
  ), upd AS (
    UPDATE public.pack_open_pulls p
       SET edition_id = f.edition_id,
           resolved_via = f.via,
           resolved_at = CASE WHEN f.edition_id IS NOT NULL THEN now() END,
           local_checked_at = clock_timestamp()
      FROM found f
     WHERE p.collection_id = f.collection_id AND p.pack_nft_id = f.pack_nft_id AND p.nft_id = f.nft_id
    RETURNING p.collection_id, p.pack_nft_id, (f.edition_id IS NOT NULL) AS named
  ), bump AS (
    UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
      FROM (SELECT DISTINCT collection_id, pack_nft_id FROM upd WHERE named) u
     WHERE v.collection_id = u.collection_id AND v.pack_nft_id = u.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) FILTER (WHERE named) INTO v_local_named FROM upd;

  -- (3) Ask Dapper's index for what is still unnamed (All Day, Golazos only --
  -- its Top Shot index returns nothing). 200 ids a request, 5 requests a tick,
  -- each id at most 5 times, at least 6 h apart.
  FOR b IN
    WITH pend AS (
      SELECT p.collection_id, p.nft_id,
             row_number() OVER (PARTITION BY p.collection_id ORDER BY p.api_checked_at NULLS FIRST, p.nft_id) AS rn
      FROM public.pack_open_pulls p
      WHERE p.edition_id IS NULL
        AND p.collection_id IN (v_ad, v_gz)
        AND p.local_checked_at IS NOT NULL
        AND p.api_attempts < 5
        AND (p.api_checked_at IS NULL OR p.api_checked_at < now() - interval '6 hours')
        AND NOT EXISTS (SELECT 1 FROM public.pack_pull_requests q
                         WHERE q.kind = 'editions' AND q.collected_at IS NULL AND p.nft_id = ANY (q.nft_ids))
    )
    SELECT collection_id, array_agg(DISTINCT nft_id) AS ids
    FROM pend
    WHERE rn <= 1000
    GROUP BY collection_id, (rn - 1) / 200
    ORDER BY collection_id, min(rn)
    LIMIT 5
  LOOP
    SELECT net.http_post(
      url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
      body := jsonb_build_object(
        'query', CASE WHEN b.collection_id = v_ad
          THEN 'query($i: SearchAllDayNftsInput){ searchAllDayNft(searchInput:$i){ totalCount edges{ node{ id serial_number edition{ id } } } } }'
          ELSE 'query($i: SearchGolazosNftsInput){ searchGolazosNft(searchInput:$i){ totalCount edges{ node{ id serial_number edition{ id } } } } }'
        END,
        'variables', jsonb_build_object('i', jsonb_build_object(
          'first', 1000,
          'filters', jsonb_build_array(jsonb_build_object('id', jsonb_build_object('in', to_jsonb(b.ids))))
        ))
      ),
      headers := '{"Content-Type":"application/json","Origin":"https://nbatopshot.com","Referer":"https://nbatopshot.com/","User-Agent":"RipPacksCity/1.0"}'::jsonb,
      timeout_milliseconds := 30000
    ) INTO v_next;
    INSERT INTO public.pack_pull_requests (request_id, kind, collection_id, nft_ids)
    VALUES (v_next, 'editions', b.collection_id, b.ids);
    UPDATE public.pack_open_pulls
       SET api_attempts = api_attempts + 1, api_checked_at = now()
     WHERE collection_id = b.collection_id AND nft_id = ANY (b.ids) AND edition_id IS NULL;
    v_lookups := v_lookups + 1;
  END LOOP;

  -- (4) (Re)price: packs whose inputs changed (priced_at = -infinity), then the
  -- stalest older than 24 h so the value tracks current FMV. Whole-pack,
  -- all-or-nothing; fmv_usd must be > 0 to count as priced.
  INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, pull_value_usd, priced_at)
  SELECT DISTINCT ON (p.collection_id, p.pack_nft_id) p.collection_id, p.pack_nft_id, p.opener_address, 0, 0, 0, NULL, '-infinity'
    FROM public.pack_open_pulls p
   WHERE NOT EXISTS (SELECT 1 FROM public.pack_open_pull_values v
                      WHERE v.collection_id = p.collection_id AND v.pack_nft_id = p.pack_nft_id)
  ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;

  WITH pk AS MATERIALIZED (
    SELECT v.collection_id, v.pack_nft_id
    FROM public.pack_open_pull_values v
    WHERE v.priced_at < now() - interval '24 hours'
    ORDER BY v.priced_at
    LIMIT 1500
  ), agg AS (
    SELECT p.collection_id, p.pack_nft_id,
           count(*)                              AS n_pulls,
           count(p.edition_id)                   AS n_resolved,
           count(f.fmv_usd)                      AS n_priced,
           sum(f.fmv_usd)                        AS total
    FROM pk
    JOIN public.pack_open_pulls p ON p.collection_id = pk.collection_id AND p.pack_nft_id = pk.pack_nft_id
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd FROM public.fmv_snapshots s
       WHERE p.edition_id IS NOT NULL
         AND s.collection_id = p.collection_id AND s.edition_id = p.edition_id
       ORDER BY s.computed_at DESC
       LIMIT 1
    ) f0 ON true
    CROSS JOIN LATERAL (SELECT CASE WHEN f0.fmv_usd > 0 THEN f0.fmv_usd END AS fmv_usd) f
    GROUP BY p.collection_id, p.pack_nft_id
  ), upd AS (
    UPDATE public.pack_open_pull_values v
       SET n_pulls = a.n_pulls, n_resolved = a.n_resolved, n_priced = a.n_priced,
           pull_value_usd = CASE WHEN a.n_priced = a.n_pulls THEN round(a.total, 2) END,
           priced_at = clock_timestamp()
      FROM agg a
     WHERE v.collection_id = a.collection_id AND v.pack_nft_id = a.pack_nft_id
    RETURNING v.pull_value_usd
  )
  SELECT count(*), count(pull_value_usd) INTO v_priced_packs, v_valued_packs FROM upd;

  PERFORM public.log_pipeline_run(
    'wallet-pack-pulls', v_started,
    v_requests, v_pulls_new + v_api_named + v_local_named + v_priced_packs, 0,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('requests_ok', v_ok, 'requests_failed', v_failed, 'requests_expired', v_expired,
                       'wallet_pages', v_pages, 'wallets_done', v_wallets_done,
                       'pulls_new', v_pulls_new, 'editions_named_local', v_local_named,
                       'editions_named_api', v_api_named, 'edition_lookups_dispatched', v_lookups,
                       'packs_priced', v_priced_packs, 'packs_valued', v_valued_packs)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'requests', v_requests, 'requests_ok', v_ok,
                            'requests_failed', v_failed, 'requests_expired', v_expired,
                            'wallet_pages', v_pages, 'wallets_done', v_wallets_done,
                            'pulls_new', v_pulls_new, 'editions_named_local', v_local_named,
                            'editions_named_api', v_api_named, 'edition_lookups_dispatched', v_lookups,
                            'packs_priced', v_priced_packs, 'packs_valued', v_valued_packs,
                            'last_error', v_last_error);
END;
$function$;
-- <<< END verbatim <<<

INSERT INTO public.collections VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 'NBA Top Shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day', 'NFL All Day'),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'laliga_golazos', 'LaLiga Golazos');
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1'),
  ('00000000-0000-0000-0000-0000000000a2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2'),
  ('00000000-0000-0000-0000-0000000000a3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:3'),
  ('00000000-0000-0000-0000-0000000000a9', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '9:9'),
  ('00000000-0000-0000-0000-0000000000b1', 'dee28451-5d62-409e-a1ad-a83f763ac070', '4080'),
  ('00000000-0000-0000-0000-0000000000b2', 'dee28451-5d62-409e-a1ad-a83f763ac070', '4090'),
  ('00000000-0000-0000-0000-0000000000c1', '06248cc4-b85f-47cd-af67-1855d14acd75', '572');
-- Top Shot 101 via moments; 102 via wallet_moments_cache (another wallet's row);
-- 103's edition has FMV 0. A Top Shot moments row with id 202 must NOT name the
-- All Day pull 202 (claim 2).
INSERT INTO public.moments VALUES
  ('101', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1'),
  ('103', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a3'),
  ('202', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a9');
INSERT INTO public.wallet_moments_cache VALUES
  ('0xsomeoneelse00000', '102', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2');
INSERT INTO public.allday_pack_pull VALUES ('A1', '201', '00000000-0000-0000-0000-0000000000b1');
INSERT INTO public.golazos_pack_open_pulls VALUES ('301', 'G1', '572');
INSERT INTO public.fmv_snapshots VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1', 1.00, now() - interval '2 days'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a1', 5.00, now() - interval '1 hour'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a2', 7.25, now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a3', 0,    now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a9', 99,   now()),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '00000000-0000-0000-0000-0000000000b1', 2.00, now()),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '00000000-0000-0000-0000-0000000000b2', 3.50, now()),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', '00000000-0000-0000-0000-0000000000c1', 4.00, now());

-- Page 1 of the wallet walk, landed.
INSERT INTO public.pack_pull_wallet_state (wallet, requested_at) VALUES ('0xbd94cade097e50ac', now());
INSERT INTO public.pack_pull_requests (request_id, kind, wallet, page) VALUES (1, 'wallet', '0xbd94cade097e50ac', 1);
INSERT INTO net._http_response VALUES (1, 200, $j${"data":{"searchPackNft":{"totalCount":6,"pageInfo":{"endCursor":"c1","hasNextPage":false},"edges":[
  {"node":{"id":"T1","type_name":"A.0b2a3299cc857e29.PackNFT.NFT","status":"Opened","nfts":"A.0b2a3299cc857e29.TopShot.101,A.0b2a3299cc857e29.TopShot.102"}},
  {"node":{"id":"T2","type_name":"A.0b2a3299cc857e29.PackNFT.NFT","status":"Opened","nfts":"A.0b2a3299cc857e29.TopShot.103"}},
  {"node":{"id":"A1","type_name":"A.e4cf4bdc1751c65d.PackNFT.NFT","status":"Opened","nfts":"A.e4cf4bdc1751c65d.AllDay.201,A.e4cf4bdc1751c65d.AllDay.202"}},
  {"node":{"id":"G1","type_name":"A.87ca73a41bb50ad5.PackNFT.NFT","status":"Opened","nfts":"A.87ca73a41bb50ad5.Golazos.301"}},
  {"node":{"id":"S1","type_name":"A.0b2a3299cc857e29.PackNFT.NFT","status":"Sealed","nfts":"A.0b2a3299cc857e29.TopShot.999"}},
  {"node":{"id":"X1","type_name":"A.ffffffffffffffff.PackNFT.NFT","status":"Opened","nfts":"A.ffffffffffffffff.Other.1"}}
]}}}$j$, NULL);

DO $$
DECLARE v jsonb; n int;
BEGIN
  v := public.collect_wallet_pack_pulls();
  PERFORM _assert((v->>'ok')::boolean, 'clean page -> ok');

  -- claim 1
  SELECT count(*) INTO n FROM public.pack_open_pulls;
  PERFORM _assert_eq(n::text, '6', 'six pulls from four opened packs; sealed + unknown type add nothing');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.pack_open_pulls WHERE pack_nft_id IN ('S1', 'X1')), 'no sealed/unknown-type rows');
  PERFORM _assert((SELECT completed_at IS NOT NULL AND last_error IS NULL AND packs = 6 AND pulls = 6
                     FROM public.pack_pull_wallet_state), 'last page -> walk complete, counts recorded');

  -- claim 2
  PERFORM _assert((SELECT edition_id IS NULL FROM public.pack_open_pulls WHERE nft_id = '202'),
                  'a Top Shot moments row never names an All Day pull with the same id');
  PERFORM _assert_eq((SELECT resolved_via FROM public.pack_open_pulls WHERE nft_id = '102'), 'wallet_moments_cache', '102 via wmc');
  PERFORM _assert_eq((SELECT resolved_via FROM public.pack_open_pulls WHERE nft_id = '201'), 'allday_pack_pull', '201 via allday_pack_pull');
  PERFORM _assert_eq((SELECT resolved_via FROM public.pack_open_pulls WHERE nft_id = '301'), 'golazos_pack_open_pulls', '301 via golazos pulls');

  -- claim 3
  PERFORM _assert_eq((SELECT pull_value_usd::text FROM public.pack_open_pull_values WHERE pack_nft_id = 'T1'), '12.25',
                     'T1 = latest FMV 5.00 (not the older 1.00) + 7.25');
  PERFORM _assert((SELECT pull_value_usd IS NULL AND n_pulls = 1 AND n_priced = 0 FROM public.pack_open_pull_values WHERE pack_nft_id = 'T2'),
                  'an FMV of 0 is unpriced: T2 is NULL, never $0');
  PERFORM _assert((SELECT pull_value_usd IS NULL AND n_pulls = 2 AND n_priced = 1 FROM public.pack_open_pull_values WHERE pack_nft_id = 'A1'),
                  'a half-priced pack publishes NO partial sum');
  PERFORM _assert_eq((SELECT pull_value_usd::text FROM public.pack_open_pull_values WHERE pack_nft_id = 'G1'), '4.00', 'G1 priced');

  -- claim 4: the unnamed All Day pull went to Dapper's index
  PERFORM _assert((SELECT nft_ids = ARRAY['202'] AND collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
                     FROM public.pack_pull_requests WHERE kind = 'editions'), 'one All Day lookup for 202');
  PERFORM _assert((SELECT body->>'query' LIKE '%searchAllDayNft%' FROM net.calls ORDER BY id DESC LIMIT 1), 'lookup asks searchAllDayNft');
END $$;

-- Dapper answers the lookup.
INSERT INTO net._http_response
SELECT request_id, 200, '{"data":{"searchAllDayNft":{"totalCount":1,"edges":[{"node":{"id":"202","serial_number":"5","edition":{"id":"4090"}}}]}}}', NULL
  FROM public.pack_pull_requests WHERE kind = 'editions';

DO $$
DECLARE v jsonb;
BEGIN
  v := public.collect_wallet_pack_pulls();
  PERFORM _assert_eq(v->>'editions_named_api', '1', 'the lookup named 202');
  PERFORM _assert_eq((SELECT pull_value_usd::text FROM public.pack_open_pull_values WHERE pack_nft_id = 'A1'), '5.50',
                     'A1 repriced once every pull is named: 2.00 + 3.50');
  PERFORM _assert((SELECT count(*) = 0 FROM public.pack_pull_requests WHERE collected_at IS NULL), 'nothing left in flight');
END $$;

-- claim 3, at the table: a partial sum cannot be stored at all.
DO $$
BEGIN
  BEGIN
    INSERT INTO public.pack_open_pull_values VALUES
      ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Z1', '0xw', 3, 3, 2, 10.00, now());
    PERFORM _assert(false, 'CHECK must refuse a value on a partly priced pack');
  EXCEPTION WHEN check_violation THEN
    PERFORM _assert(true, 'CHECK refuses a partial sum');
  END;
END $$;

-- claim 5: a page with a next page keeps the walk open and dispatches page 2;
-- a failed page ends it with an error and ok=false.
INSERT INTO public.pack_pull_wallet_state (wallet, requested_at) VALUES ('0x1111111111111111', now()), ('0x2222222222222222', now());
INSERT INTO public.pack_pull_requests (request_id, kind, wallet, page) VALUES (2, 'wallet', '0x1111111111111111', 1), (3, 'wallet', '0x2222222222222222', 1);
INSERT INTO net._http_response VALUES
  (2, 200, '{"data":{"searchPackNft":{"totalCount":1500,"pageInfo":{"endCursor":"next-1","hasNextPage":true},"edges":[]}}}', NULL),
  (3, 503, 'upstream unavailable', NULL);

DO $$
DECLARE v jsonb;
BEGIN
  v := public.collect_wallet_pack_pulls();
  PERFORM _assert(NOT (v->>'ok')::boolean, 'a failed page -> ok=false');
  PERFORM _assert((SELECT completed_at IS NULL FROM public.pack_pull_wallet_state WHERE wallet = '0x1111111111111111'),
                  'a page with a next page is NOT a completed walk');
  PERFORM _assert((SELECT count(*) = 1 FROM public.pack_pull_requests
                    WHERE wallet = '0x1111111111111111' AND page = 2 AND after_cursor = 'next-1' AND collected_at IS NULL),
                  'page 2 dispatched with the cursor');
  PERFORM _assert((SELECT completed_at IS NOT NULL AND last_error LIKE 'page 1:%' FROM public.pack_pull_wallet_state WHERE wallet = '0x2222222222222222'),
                  'a failed page ends the walk WITH its error');
  PERFORM _assert((SELECT ok = false FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'the pipeline row says ok=false');
END $$;

ROLLBACK;
