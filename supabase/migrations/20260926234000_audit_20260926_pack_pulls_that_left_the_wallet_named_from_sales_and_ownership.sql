-- 2026-09-26 (PT) — a Top Shot pull that LEFT the wallet is named from the
-- records we already hold about that moment id.
--
-- WHY (Trevor: "I don't understand why we have such low coverage of
-- understanding the moments inside the packs"). Measured 14:10 PT: 31,128 Top
-- Shot pack pulls sat with edition_id NULL across the saved wallets, so their
-- packs could never be priced (whole-pack rule). collect_wallet_pack_pulls names
-- a Top Shot pull only from `moments` / wallet_moments_cache -- i.e. only while
-- someone we walk still HOLDS it -- and Dapper's Top Shot index answers nothing.
-- A pulled moment that was sold on is exactly the one that falls through. On
-- 0xbd94cade097e50ac: 10 opened packs unpriced by 13 such pulls.
--
-- Four tables already name a Top Shot moment by id. Measured against 20,000
-- pulls ALREADY named from `moments` (positive control, same id space):
--   sales (collection-scoped)             5,422 / 5,425 agree  (99.94 %)
--   topshot_ownership (on-chain walk)     1,905 / 1,908 agree  (99.84 %)
--   Atlas market events, Standard         2,618 / 2,621 agree  (99.9 %)
--   Atlas market events, parallels        ~92 % (Blockchain 300/325) -> NOT used
--   nft_edition_map                       (160 of the unnamed; same shape)
-- Reach on the 31,128 unnamed: sales 2,979 · ownership 471 · Atlas 658 ·
-- nft_edition_map 159 -- 3,235+ distinct pulls, 0 multi-edition answers within
-- a source; sales vs Atlas disagree on 8, which stay unnamed (a pull is named
-- only when every source that answers agrees).
--
-- WHAT. One LEFT JOIN LATERAL in step (2), consulted only when the existing four
-- sources say nothing, Top Shot only (Atlas product = 'nba'). resolved_via
-- records which source(s) answered ('sales+topshot_ownership', ...). The body
-- is otherwise byte-identical to 20260926153000; applied to prod as a guarded
-- splice of that one hunk (live md5 before = ee238a732c5b5ad943f7143d1778c8b5).
--
-- anon-exec: unchanged (collect_wallet_pack_pulls) — body replacement of an existing fn; ACL preserved (postgres, service_role only).
--
-- Revert: re-run the collect_wallet_pack_pulls DDL from
--   20260926153000_audit_20260926_wallet_pack_pulls_named_by_dapper_index_so_every_rip_can_be_priced.sql
--   (pulls already named keep their edition -- each is a recorded fact about
--   that moment id; to unwind them too:
--   UPDATE pack_open_pulls SET edition_id = NULL, resolved_via = NULL, resolved_at = NULL
--    WHERE resolved_via IN ('sales','topshot_ownership','nft_edition_map','atlas_market_events')
--       OR resolved_via LIKE '%+%';
--   UPDATE pack_open_pull_values SET priced_at = '-infinity';)

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
    SELECT c.*, coalesce(m.edition_id, ap.edition_id, gz.id, wm.id,
                         CASE WHEN tx.n_named = 1 THEN tx.edition_id END) AS edition_id,
           CASE WHEN m.edition_id IS NOT NULL THEN 'moments'
                WHEN ap.edition_id IS NOT NULL THEN 'allday_pack_pull'
                WHEN gz.id IS NOT NULL THEN 'golazos_pack_open_pulls'
                WHEN wm.id IS NOT NULL THEN 'wallet_moments_cache'
                WHEN tx.n_named = 1 THEN tx.via END AS via
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
    -- 2026-09-26: a Top Shot moment that has LEFT the wallet is in neither
    -- moments nor the wallet cache, and Dapper's Top Shot index answers nothing
    -- -- 31,128 pulls sat unnamed. Four records we already hold name one by its
    -- id: a recorded sale, the on-chain ownership walk, the nft->edition map, and
    -- a Standard Atlas market event (parallels there matched 92 %, Standard
    -- 99.9 %, so parallels are not used). Named only when every source that
    -- answers agrees; a conflict stays unnamed. Top Shot only, product 'nba'.
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT o.edition_id) AS n_named,
             min(o.edition_id::text)::uuid AS edition_id,
             string_agg(DISTINCT o.via, '+' ORDER BY o.via) AS via
      FROM (
        SELECT s.edition_id, 'sales'::text AS via FROM public.sales s
         WHERE c.collection_id = v_ts AND s.collection_id = v_ts AND s.nft_id = c.nft_id
           AND s.edition_id IS NOT NULL
        UNION ALL
        SELECT ed.id, 'topshot_ownership' FROM public.topshot_ownership t
          JOIN public.editions ed ON ed.collection_id = v_ts AND ed.external_id = t.edition_external_id
         WHERE c.collection_id = v_ts AND t.nft_id = c.nft_id
        UNION ALL
        SELECT ed.id, 'nft_edition_map' FROM public.nft_edition_map n
          JOIN public.editions ed ON ed.collection_id = v_ts AND ed.external_id = n.edition_external_id
         WHERE c.collection_id = v_ts AND n.collection_id = v_ts AND n.nft_id = c.nft_id
        UNION ALL
        SELECT ed.id, 'atlas_market_events' FROM public.topshot_atlas_market_events a
          JOIN public.topshot_atlas_edition_map am ON am.atlas_edition_id = a.atlas_edition_id
          JOIN public.editions ed ON ed.id = am.rpc_edition_id AND ed.collection_id = v_ts
         WHERE c.collection_id = v_ts AND a.product = 'nba' AND a.nft_id = c.nft_id
           AND a.parallel = 'Standard' AND am.parallel = 'Standard'
      ) o
    ) tx ON true
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
