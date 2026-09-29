-- 2026-09-29 (PT) — a BOX pack yields packs, not moments.
--
-- WHY. searchPackNft.nfts lists what a pack revealed as "A.<addr>.<Contract>.<id>".
-- collect_wallet_pack_pulls kept only the id ("a pack only ever yields its own
-- collection's moments"). A box does not: "2026 NBA Finals Box" (pack
-- 162727723599629) revealed 8 "A.0b2a3299cc857e29.PackNFT.<id>". So every box's
-- inner packs sat in pack_open_pulls as unnamed MOMENTS -- 3,365 of them in 430
-- Top Shot boxes over 12 saved wallets (3,242 are themselves opened packs we
-- hold) -- and each box read "0 of 8 priced" for ever. (An All Day "match" in
-- the same probe was a moment id equal to a pack id: its tokens say AllDay.)
--
-- WHAT.
--   pack_box_contents     (collection, box, inner pack, opener).
--   One-time move: Top Shot pulls with id >= 1,000,000,000 -> pack_box_contents.
--     Top Shot moment ids top out at 53,007,767 (2.48M known ids, 2026-09-29) and
--     its PackNFT ids start at ~1.48e9, so the two cannot be confused. Their
--     pull-value rows: deleted where no moment pull remains, else re-priced.
--   collect_wallet_pack_pulls (guarded splice, base d0799d8085f9116d58e62c79589fa3a6
--     = 20260926234000): PackNFT tokens go to pack_box_contents, never
--     pack_open_pulls.
--   get_wallet_pack_history v19 (base 31605f9aee328428264d92f149b7e682 = 20260929133500):
--     box_packs per row.
-- anon-exec: unchanged (collect_wallet_pack_pulls) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-29).
-- anon-exec: unchanged (get_wallet_pack_history) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-29).
--
-- Revert: re-apply collect_wallet_pack_pulls from 20260926234000 and
--   get_wallet_pack_history from 20260929133500 (repoint both pins); then
--   INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address)
--     SELECT collection_id, box_pack_nft_id, pack_nft_id, opener_address FROM public.pack_box_contents
--     ON CONFLICT DO NOTHING;
--   DROP TABLE public.pack_box_contents;

CREATE TABLE IF NOT EXISTS public.pack_box_contents (
  collection_id   uuid NOT NULL,
  box_pack_nft_id text NOT NULL,
  pack_nft_id     text NOT NULL,
  opener_address  text NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, box_pack_nft_id, pack_nft_id)
);
COMMENT ON TABLE public.pack_box_contents IS
  'The packs a BOX pack yielded (searchPackNft.nfts tokens of contract PackNFT). Written by collect_wallet_pack_pulls(); never moments, so never priced as pulls.';
CREATE INDEX IF NOT EXISTS idx_pack_box_contents_opener ON public.pack_box_contents (opener_address);
ALTER TABLE public.pack_box_contents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_box_contents FROM anon, authenticated;

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.collect_wallet_pack_pulls()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'd0799d8085f9116d58e62c79589fa3a6' AND v_md5 IS DISTINCT FROM 'ef351c787e4d4f864f3c010f34bdb162' THEN
    RAISE EXCEPTION 'collect_wallet_pack_pulls changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_wallet_pack_history(text, text, text, integer, integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '31605f9aee328428264d92f149b7e682' AND v_md5 IS DISTINCT FROM '82f37ebc1eeb4a3304f992cb90771192' THEN
    RAISE EXCEPTION 'get_wallet_pack_history changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

-- One-time move (write first, then delete only what was written).
WITH mv AS (
  INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address, first_seen_at)
  SELECT p.collection_id, p.pack_nft_id, p.nft_id, p.opener_address, p.first_seen_at
    FROM public.pack_open_pulls p
   WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND p.nft_id ~ '^[0-9]{10,}$'
  ON CONFLICT DO NOTHING
  RETURNING collection_id, box_pack_nft_id, pack_nft_id
)
-- the CTE's RETURNING rows: a data-modifying CTE's inserts are invisible to
-- this statement's own read of pack_box_contents
DELETE FROM public.pack_open_pulls p
 USING mv
 WHERE p.collection_id = mv.collection_id AND p.pack_nft_id = mv.box_pack_nft_id AND p.nft_id = mv.pack_nft_id;

-- pull-value rows of boxes: gone where no moment pull remains, re-priced otherwise
DELETE FROM public.pack_open_pull_values v
 WHERE v.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND EXISTS (SELECT 1 FROM public.pack_box_contents b WHERE b.collection_id = v.collection_id AND b.box_pack_nft_id = v.pack_nft_id)
   AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls p WHERE p.collection_id = v.collection_id AND p.pack_nft_id = v.pack_nft_id);
UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
 WHERE v.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND EXISTS (SELECT 1 FROM public.pack_box_contents b WHERE b.collection_id = v.collection_id AND b.box_pack_nft_id = v.pack_nft_id);

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
      -- 2026-09-29: a BOX yields packs, not moments ("A.<addr>.PackNFT.<id>",
      -- e.g. "2026 NBA Finals Box" -> 8 PackNFTs). Those go to
      -- pack_box_contents; before, each was stored as an unnamed moment and the
      -- box read "0 of 8 priced" for ever (430 Top Shot boxes, 12 wallets).
      INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
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
        AND t.tok ~ '^A\.[0-9a-f]+\.PackNFT\.[0-9]+$'
      ON CONFLICT (collection_id, box_pack_nft_id, pack_nft_id) DO NOTHING;

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
          AND split_part(t.tok, '.', 3) <> 'PackNFT'
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

CREATE OR REPLACE FUNCTION public.get_wallet_pack_history(p_wallet text, p_collection_slug text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_safe_limit  int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_safe_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_ts uuid;
  v_ad uuid;
  v_gz uuid;
  v_pin uuid;
  v_total int;
  v_packs jsonb;
  v_sync jsonb;
  -- Start of this wallet's most recent CLEAN full walk
  -- (pack_wallet_sync.last_clean_sync_at). Every pack that walk returned was
  -- stamped checked_at = now() as it was collected, i.e. at or after this
  -- instant -- so a row still naming this wallet with an OLDER checked_at is a
  -- pack the walk no longer found here: one the wallet has parted with.
  -- NULL when no clean walk has ever finished (never synced, one in flight,
  -- errored, or the 60-page cap hit). The guards below then trust the index
  -- as-is, because suppressing on a PARTIAL walk would read every page it
  -- never reached as a mass departure -- the same defect pointing the other way.
  v_sync_floor timestamptz;
BEGIN
  IF v_wallet = '' THEN
    RETURN jsonb_build_object('error', 'wallet required');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';
  SELECT id INTO v_pin FROM public.collections WHERE slug = 'disney_pinnacle';

  SELECT jsonb_build_object('requested_at', s.requested_at, 'completed_at', s.completed_at,
                            'pages', s.pages, 'packs', s.packs, 'last_error', s.last_error,
                            'last_clean_sync_at', s.last_clean_sync_at),
         s.last_clean_sync_at
    INTO v_sync, v_sync_floor
    FROM public.pack_wallet_sync s WHERE s.wallet = v_wallet;

  WITH buy_src AS (
    -- (1) on-chain, via pack-events-ingest: secondary ListingCompleted rows AND
    --     primary Withdraw/Mint rows (sale_price NULL on chain -> priced at retail below)
    SELECT pack_nft_id, collection_id, sale_price AS price, sale_currency AS currency,
           sealed_at AS at, seller_address AS counterparty, is_primary_drop, event_kind,
           pack_dist_id AS dist_id, 'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases WHERE buyer_address = v_wallet
    UNION ALL
    -- (2) Dapper marketplace history (Atlas walker). Buyer-side rows. USD.
    SELECT pack_nft_id, v_ts, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history WHERE buyer_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_ad, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history WHERE buyer_address = v_wallet AND purchased
    UNION ALL
    -- 2026-09-26: Golazos marketplace history (same walker shape, same meaning).
    SELECT pack_nft_id, v_gz, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.golazos_pack_sales_history WHERE buyer_address = v_wallet AND purchased
  ),
  -- One buy per pack. The same purchase is often in BOTH sources with DIFFERENT
  -- timestamps: the marketplace row carries the sale moment, the on-chain row
  -- the settlement, which lands later by a median 4 h and a p90 of 9 DAYS
  -- (31,995 matched Top Shot pairs, Jun-Aug 2026). So rows within 30 days of
  -- the pack's latest buy row are ONE purchase: price/counterparty come from
  -- its latest row (on-chain on a tie), bought_at is the EARLIEST of them --
  -- otherwise a quick flip whose on-chain settlement post-dates the resale
  -- reads as "bought back" and renders HELD.
  buy_ranked AS (
    SELECT b.*, MAX(at) OVER (PARTITION BY collection_id, pack_nft_id) AS max_at
    FROM buy_src b
  ),
  latest_buys AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id)
           pack_nft_id, collection_id, price AS buy_price, currency AS buy_currency,
           MIN(at) FILTER (WHERE at >= max_at - interval '30 days')
             OVER (PARTITION BY collection_id, pack_nft_id) AS bought_at,
           counterparty AS bought_from, is_primary_drop AS bought_primary,
           event_kind AS bought_event_kind, src AS buy_src
    FROM buy_ranked
    ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  buy_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM buy_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  ),
  sell_src AS (
    -- (1) on-chain rows whose seller IS this wallet: rows the worker ingests
    --     after its Withdraw.from fix, plus the 68,889 historical rows the
    --     2026-09-18 backfill re-attributed from the marketplace tables.
    SELECT pack_nft_id, collection_id, sale_price AS price, sale_currency AS currency,
           sealed_at AS at, buyer_address AS counterparty, pack_dist_id AS dist_id,
           'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases WHERE seller_address = v_wallet
    UNION ALL
    -- (2) marketplace history: storefront_address is the SELLING wallet.
    SELECT pack_nft_id, v_ts, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history WHERE storefront_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_ad, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history WHERE storefront_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_gz, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.golazos_pack_sales_history WHERE storefront_address = v_wallet AND purchased
  ),
  latest_sells AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id)
           pack_nft_id, collection_id, price AS sell_price, currency AS sell_currency,
           at AS sold_at, counterparty AS sold_to, src AS sell_src
    FROM sell_src
    ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  sell_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM sell_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  ),
  wallet_rips AS (
    SELECT id, pack_nft_id, collection_id, sealed_at, moments_pulled, dist_id, pull_value_usd,
           'rip'::text AS rip_source, NULL::int AS rc_pulls, NULL::int AS rc_resolved, NULL::int AS rc_priced
    FROM public.pack_rips WHERE opener_address = v_wallet
    UNION ALL
    -- 2026-09-26: Golazos and Pinnacle opens live in their own tables (pack_rips
    -- holds neither -- 0 rows each), so the Opened tab never listed them.
    SELECT NULL::uuid, pack_nft_id, v_gz, opened_at, moments_pulled, dist_id, pull_value_usd,
           'rip', NULL, NULL, NULL
    FROM public.golazos_pack_opens WHERE opener_address = v_wallet
    UNION ALL
    SELECT NULL::uuid, pack_nft_id, v_pin, opened_at, moments_pulled, dist_id, pull_value_usd,
           'rip', NULL, NULL, NULL
    FROM public.pinnacle_pack_opens WHERE opener_address = v_wallet
    UNION ALL
    -- 2026-09-26 (v9): packs opened with NO pack NFT (custodial Top Shot packs),
    -- reconstructed from the wallet's pack-pull delivery bursts
    -- (wallet_reconstructed_rips). No dist, no price paid; rip_source says so.
    SELECT NULL::uuid, burst_id, collection_id, opened_at, moments_pulled, NULL::text, pull_value_usd,
           'reconstructed', moments_pulled, n_resolved, n_priced
    FROM public.wallet_reconstructed_rips WHERE wallet = v_wallet
  ),
  -- (3) Dapper's index of what the wallet HOLDS or OPENED (pack_nft_identity,
  --     filled by the pack-nft-identity lane's wallet sync): the packs our
  --     buy/rip tables never saw -- reward packs, boxes and drops from before
  --     on-chain coverage. Ranked below every sale and rip we hold.
  index_holds AS (
    SELECT pack_nft_id, collection_id, acquired_at AS at,  -- 2026-09-24: never the CHECK time (see header)
           CASE WHEN status = 'Opened' THEN 'idx_open' ELSE 'idx_hold' END AS role
    FROM public.pack_nft_identity
    WHERE owner_address = v_wallet AND status IN ('Sealed', 'Opened')
      -- ... and this wallet's own last clean walk still found it here. Without
      -- this arm a pack that LEFT keeps owner_address = this wallet for ever --
      -- pack_nft_identity_queue only ever enqueues a pack carrying a purchase or
      -- a rip row, so an OPENED pack that leaves is re-checked through its new
      -- owner's purchase while a SEALED one that leaves by transfer has no
      -- re-check path at all -- and the reader publishes it to the user as an
      -- unopened pack they still own. Measured 2026-09-20 across the 27 saved
      -- wallets: 23 such rows on 5 wallets, and 23 of 23 were Sealed.
      AND (v_sync_floor IS NULL OR checked_at >= v_sync_floor)
  ),
  events AS (
    SELECT collection_id, pack_nft_id, bought_at AS event_at, 'buy'::text AS role FROM latest_buys
    UNION ALL
    SELECT collection_id, pack_nft_id, sold_at, 'sell' FROM latest_sells
    UNION ALL
    SELECT collection_id, pack_nft_id, sealed_at, 'rip' FROM wallet_rips
    UNION ALL
    SELECT collection_id, pack_nft_id, at, role FROM index_holds
  ),
  dedup AS (
    SELECT collection_id, pack_nft_id,
      MAX(event_at)              AS latest_event_at,
      MIN(event_at)              AS first_event_at,
      bool_or(role = 'buy')      AS has_buy,
      bool_or(role = 'sell')     AS has_sell,
      bool_or(role = 'rip')      AS has_rip,
      bool_or(role = 'idx_hold') AS has_idx_hold,
      bool_or(role = 'idx_open') AS has_idx_open
    FROM events GROUP BY 1, 2
  ),
  resolved AS (
    SELECT
      d.*,
      c.slug AS collection_slug, c.name AS collection_name,
      lb.buy_price, lb.buy_currency, lb.bought_at, lb.bought_from, lb.bought_primary,
      lb.bought_event_kind, lb.buy_src,
      ls.sell_price, ls.sell_currency, ls.sold_at, ls.sold_to, ls.sell_src,
      wr.id AS rip_id, wr.sealed_at AS ripped_at,
      -- 2026-09-26: what the pack yielded, from Dapper's own list of its moments
      -- (pack_open_pull_values, the wallet-pack-pulls lane) first; the rip
      -- record's value only where that list has not been priced. Both are
      -- current FMV, whole-pack, NULL -- never 0 -- when any pull is unpriced.
      COALESCE(wr.moments_pulled, pov.n_pulls) AS moments_pulled,
      COALESCE(pov.pull_value_usd, wr.pull_value_usd) AS pull_value_usd,
      CASE WHEN pov.pull_value_usd IS NOT NULL THEN 'dapper_pulls'
           WHEN wr.pull_value_usd IS NOT NULL AND wr.rip_source = 'reconstructed' THEN 'delivery_burst'
           WHEN wr.pull_value_usd IS NOT NULL THEN 'rip_record'
      END AS pull_value_source,
      COALESCE(pov.n_pulls,    wr.rc_pulls)    AS pulls_total,
      COALESCE(pov.n_resolved, wr.rc_resolved) AS pulls_identified,
      COALESCE(pov.n_priced,   wr.rc_priced)   AS pulls_priced,
      -- v18: how many of the pack's pulls are named by inference (id neighbours)
      pov.n_inferred                           AS pulls_inferred,
      wr.rip_source,
      -- Dapper's own index of the pack (pack_nft_identity, filled by the
      -- pack-nft-identity lane): current owner + Sealed/Opened, as of checked_at.
      -- TRUE when the index still names this wallet but the wallet's last clean
      -- walk did not return the pack: it has left. NULL when we cannot tell --
      -- no identity row, or no clean walk to measure against -- so every arm
      -- below reads it through coalesce(..., false) and never lets "unknown"
      -- decide anything.
      CASE WHEN pi.pack_nft_id IS NULL OR v_sync_floor IS NULL THEN NULL
           ELSE (pi.owner_address = v_wallet AND pi.checked_at < v_sync_floor)
      END AS index_departed,
      -- Once it has left, the index's owner_address is a name we KNOW to be
      -- wrong, so this says unknown rather than repeating it back.
      CASE WHEN v_sync_floor IS NOT NULL AND pi.owner_address = v_wallet
                AND pi.checked_at < v_sync_floor THEN NULL
           ELSE pi.owner_address
      END AS current_owner,
      pi.status        AS identity_status,
      pi.checked_at    AS identity_checked_at,
      pi.acquired_at   AS identity_acquired_at,
      -- distribution: rip > the wallet's own rows > any marketplace row > the index
      COALESCE(wr.dist_id, bd.dist_id, sd.dist_id, hx.dist_id, NULLIF(pi.dist_id, '0')) AS dist_id,
      CASE
        WHEN wr.dist_id IS NOT NULL THEN 'rip'
        WHEN bd.dist_id IS NOT NULL OR sd.dist_id IS NOT NULL THEN 'own_row'
        WHEN hx.dist_id IS NOT NULL THEN 'peer_sale'
        WHEN NULLIF(pi.dist_id, '0') IS NOT NULL THEN 'dapper_index'
        ELSE NULL
      END AS dist_source
    FROM dedup d
    JOIN public.collections c ON c.id = d.collection_id
    LEFT JOIN latest_buys  lb ON lb.collection_id = d.collection_id AND lb.pack_nft_id = d.pack_nft_id
    LEFT JOIN latest_sells ls ON ls.collection_id = d.collection_id AND ls.pack_nft_id = d.pack_nft_id
    LEFT JOIN wallet_rips  wr ON wr.collection_id = d.collection_id AND wr.pack_nft_id = d.pack_nft_id
    LEFT JOIN buy_dist     bd ON bd.collection_id = d.collection_id AND bd.pack_nft_id = d.pack_nft_id
    LEFT JOIN sell_dist    sd ON sd.collection_id = d.collection_id AND sd.pack_nft_id = d.pack_nft_id
    LEFT JOIN public.pack_nft_identity pi ON pi.collection_id = d.collection_id AND pi.pack_nft_id = d.pack_nft_id
    LEFT JOIN public.pack_open_pull_values pov
      ON pov.collection_id = d.collection_id AND pov.pack_nft_id = d.pack_nft_id AND pov.opener_address = v_wallet
    LEFT JOIN LATERAL (
      SELECT h.dist_id FROM public.topshot_pack_sales_history h
      WHERE d.collection_id = v_ts
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      UNION ALL
      SELECT h.dist_id FROM public.allday_pack_sales_history h
      WHERE d.collection_id = v_ad
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      UNION ALL
      SELECT h.dist_id FROM public.golazos_pack_sales_history h
      WHERE d.collection_id = v_gz
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      LIMIT 1
    ) hx ON true
  ),
  enriched AS (
    SELECT
      r.*,
      COALESCE(pd.title, CASE WHEN r.rip_source = 'reconstructed'
                              THEN r.collection_name || ' pack (no pack NFT, reconstructed)' END) AS pack_name,
      pd.image_url          AS pack_image,
      pd.metadata->>'tier'  AS pack_tier,
      pd.total_sealed       AS dist_total_sealed,
      pd.total_opened       AS dist_total_opened,
      rt.retail_usd,
      mt.minted_at AS minted_to_wallet_at,
      am.minted_at AS primary_minted_at,
      -- what the wallet PAID: on-chain/marketplace price for a secondary buy,
      -- the distribution's retail price for a primary drop, NULL when unknown.
      -- 2026-09-26 (v10): ... and, for a pack with NO buy row that can only have
      -- come from Dapper, the drop's retail price, labelled 'retail_inferred'.
      CASE WHEN r.bought_primary THEN rt.retail_usd
           WHEN NOT r.has_buy AND inf.inferable THEN rt.retail_usd
           ELSE r.buy_price END AS buy_usd,
      CASE
        WHEN NOT r.has_buy AND inf.inferable AND rt.retail_usd IS NOT NULL THEN 'retail_inferred'
        WHEN NOT r.has_buy THEN NULL
        WHEN r.bought_primary AND rt.retail_usd IS NOT NULL THEN 'retail'
        WHEN r.bought_primary THEN NULL
        WHEN r.buy_price IS NULL THEN NULL
        ELSE r.buy_src
      END AS buy_price_source
    FROM resolved r
    LEFT JOIN public.pack_distributions pd
      ON pd.dist_id = r.dist_id AND pd.collection_id = r.collection_id
    -- 2026-09-26: retail in DOLLARS. Top Shot's pack_distributions.metadata
    -- carries some prices in UFix64 units (x1e8: 109 dists, 371 primary buys
    -- read as tens of millions of dollars); pack_retail_usd() normalises by the
    -- estate's rule (>= 1,000,000 -> /1e8). All Day keeps its drop price in
    -- allday_pack_supply.pack_price, where 0 is "not known", never "free".
    LEFT JOIN public.allday_pack_supply aps
      ON r.collection_id = v_ad AND aps.dist_id = r.dist_id
    -- 2026-09-26 (v12): an All Day distribution Dapper types REWARD cost the
    -- wallet nothing -- $0, a known price. A price of 0 on any other type stays
    -- unknown (internal holds like "Jan 29 hold" carry 0 too).
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.collection_id = v_ad AND pd.metadata->>'type' = 'REWARD' THEN 0::numeric
                  WHEN r.collection_id = v_ad THEN NULLIF(aps.pack_price, 0)
                  ELSE public.pack_retail_usd(pd.metadata->>'retail_price_usd', pd.title) END AS retail_usd
    ) rt
    -- A pack with no buy row we hold is priced at its drop's retail ONLY when it
    -- was acquired inside that drop's sale window -- from 1 day before the
    -- drop's start_time to 30 days after (the acquisition is Dapper's index
    -- date, else bounded by when the wallet sold or opened it) -- and our
    -- marketplace history covers that window (every Top Shot PackNFT; an All
    -- Day drop that started on/after 2022-12-16). An old drop acquired long
    -- after its sale (All Day Series 1 packs received in 2023-25 with no sale
    -- on record: rewards, not retail) stays NULL, as does any drop with no
    -- start_time. A transfer inside the window would read the same. Never a
    -- reconstructed rip (no distribution).
    -- 2026-09-26 (v12): an All Day drop's start from Dapper's own distribution
    -- record (allday_drop_windows) where pack_distributions carries none -- 151
    -- of 3,228 All Day distributions had start_time.
    LEFT JOIN public.allday_drop_windows adw
      ON r.collection_id = v_ad AND adw.dist_id = r.dist_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(
               CASE WHEN pg_input_is_valid(pd.metadata->>'start_time', 'timestamptz')
                    THEN (pd.metadata->>'start_time')::timestamptz END,
               adw.start_time) AS drop_start
    ) ds
    -- 2026-09-26 (v11): ... OR Dapper MINTED the pack into this wallet at the
    -- instant its index says the wallet acquired it (pack_nft_mints, read from
    -- Flow's PackNFT.Minted). A pack minted in never passed through a
    -- marketplace, so it came from Dapper however long after its drop: a
    -- custodial pack turned into an NFT (215 of 0xbd94...'s, one PDS mint on
    -- 2026-04-24) or a drop bought and minted in. Top Shot only -- its reward
    -- packs carry a retail of 0, so a reward reads "$0 (reward)"; All Day's
    -- supply price does not mark a reward, and a reward priced as a purchase is
    -- the Series 1 defect this window exists to prevent.
    -- 2026-09-28 (v15): the index's acquisition date is THIS wallet's only
    -- while the index names this wallet (current owner, or the owner it named
    -- before the pack departed). A pack the wallet SOLD carries its buyer's
    -- date -- never a fact about this wallet's acquisition.
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.current_owner = v_wallet OR coalesce(r.index_departed, false)
                  THEN r.identity_acquired_at END AS at
    ) wa
    LEFT JOIN LATERAL (
      SELECT m.minted_at FROM public.pack_nft_mints m
       WHERE r.collection_id = v_ts
         AND m.collection_id = r.collection_id AND m.pack_nft_id = r.pack_nft_id
         AND wa.at IS NOT NULL
         AND abs(extract(epoch FROM m.minted_at - wa.at)) <= 2
    ) mt ON true
    -- 2026-09-28 (v15): an All Day pack's mint in Dapper's index
    -- (pack_index_mints) dates a pack the wallet has SOLD, which otherwise had
    -- only "no later than the sale" -- when no one else sold it on the
    -- marketplace between the mint and this wallet's sale / open
    -- (allday_pack_primary_minted_at). Mint-on-demand drops mint AT the
    -- purchase (100/100 = the on-chain primary sale), but some drops are
    -- PRE-MINTED days before they open, so the wallet's own index date wins
    -- where we have one (v16): minted inside the window -> acquired inside it
    -- on 4,868 of 4,913 saved-wallet packs (99.1%); 830 pre-minted packs were
    -- acquired inside a window their mint precedes.
    LEFT JOIN LATERAL (
      SELECT public.allday_pack_primary_minted_at(r.pack_nft_id, v_wallet, LEAST(r.sold_at, r.ripped_at)) AS minted_at
       WHERE r.collection_id = v_ad AND NOT r.has_buy
    ) am ON true
    CROSS JOIN LATERAL (
      SELECT coalesce(r.dist_id IS NOT NULL
              AND r.rip_source IS DISTINCT FROM 'reconstructed'
              AND ((ds.drop_start IS NOT NULL
                    AND (r.collection_id = v_ts
                         OR (r.collection_id = v_ad AND ds.drop_start >= timestamptz '2022-12-16'))
                    -- v17: the mint only when it lies INSIDE the window. A mint
                    -- before the window (a pre-minted drop) says nothing about
                    -- when the wallet got it, so the sale / open bound decides,
                    -- as it did before v15.
                    AND COALESCE(wa.at,
                                 CASE WHEN am.minted_at BETWEEN ds.drop_start - interval '1 day'
                                                            AND ds.drop_start + interval '30 days'
                                      THEN am.minted_at END,
                                 LEAST(r.sold_at, r.ripped_at))
                          BETWEEN ds.drop_start - interval '1 day' AND ds.drop_start + interval '30 days')
                   OR mt.minted_at IS NOT NULL), false) AS inferable
    ) inf
  ),
  classified AS (
    SELECT *,
      CASE
        WHEN has_rip                                            THEN 'ripped'
        WHEN has_sell AND has_buy AND sold_at >= bought_at      THEN 'flipped'
        WHEN has_sell AND NOT has_buy                           THEN 'sold'
        -- bought, never sold or opened by this wallet, and Dapper's index says a
        -- DIFFERENT wallet holds it now: it left by transfer, or by a sale the
        -- marketplace walker has not reached. Never HELD.
        -- ... or the index no longer places it here at all. Same outcome, we
        -- just cannot name who holds it now -- and this arm is the only one that
        -- can catch it, because a stale row still says the owner IS us, which
        -- made the test above pass it straight through to HELD.
        WHEN has_buy AND ((current_owner IS NOT NULL AND current_owner <> v_wallet)
                          OR coalesce(index_departed, false))
                                                                THEN 'transferred'
        WHEN has_buy                                            THEN 'held'
        -- the index alone: opened by this wallet (no rip row of ours) or held
        WHEN has_idx_open                                       THEN 'ripped'
        WHEN has_idx_hold                                       THEN 'held'
        ELSE 'other'
      END AS status
    FROM enriched
  ),
  with_pl AS (
    SELECT *,
      CASE
        WHEN status = 'ripped'  AND pull_value_usd IS NOT NULL AND buy_usd IS NOT NULL THEN pull_value_usd - buy_usd
        WHEN status = 'flipped' AND sell_price     IS NOT NULL AND buy_usd IS NOT NULL THEN sell_price     - buy_usd
        -- 2026-09-26: a pack sold with no buy row, priced at its drop's retail
        WHEN status = 'sold'    AND sell_price     IS NOT NULL AND buy_usd IS NOT NULL
                                AND buy_price_source = 'retail_inferred'           THEN sell_price     - buy_usd
        ELSE NULL
      END AS realized_pl_usd
    FROM classified
  ),
  filtered AS (
    SELECT * FROM with_pl
    WHERE (p_collection_slug IS NULL OR collection_slug = p_collection_slug)
      AND (
        p_status IS NULL
        OR p_status = 'all'
        -- virtual status: every "no longer sealed in this wallet, sold on"
        -- outcome, regardless of whether a matching buy was attributable
        OR (p_status = 'sold_any' AND status IN ('flipped', 'sold'))
        OR status = p_status
      )
  ),
  page AS (
    SELECT * FROM filtered
    ORDER BY latest_event_at DESC NULLS LAST, collection_id, pack_nft_id
    LIMIT v_safe_limit OFFSET v_safe_offset
  ),
  -- market context, PAGE rows only: current floor ask, latest EV snapshot, last
  -- recorded secondary sale of the same distribution. All NULL when unknown.
  page_market AS (
    SELECT
      p.*,
      CASE WHEN pas.is_listed THEN pas.lowest_ask END AS lowest_ask_usd,
      pas.last_checked_at                             AS ask_checked_at,
      ev.pack_ev                                      AS pack_ev_usd,
      -- 2026-09-26 (v13): the pack's CONTENTS value -- what ripping it is
      -- expected to yield. pack_ev is that minus the drop price (net), which
      -- the row labelled "EV" (Anthology Quick Rip: contents $2.33 read "EV
      -- -$6.67"). A holder compares this with the floor ask: rip or sell.
      ev.gross_ev                                     AS pack_gross_ev_usd,
      -- 2026-09-26 (v14): where the drop has no published pool to model, what
      -- its opened packs actually yielded -- the mean current value of >= 5
      -- valued opens (pack_observed_values), with the count behind it.
      obs.avg_value_usd                               AS pack_opened_avg_usd,
      obs.n_valued                                    AS pack_opened_n,
      -- 2026-09-29 (v19): a BOX yields packs, not moments -- how many
      (SELECT count(*) FROM public.pack_box_contents bx
        WHERE bx.collection_id = p.collection_id AND bx.box_pack_nft_id = p.pack_nft_id
          AND bx.opener_address = v_wallet)::int     AS box_packs,
      ev.snapshotted_at                               AS ev_snapshotted_at,
      lsale.sale_price                                AS last_sale_usd,
      lsale.sealed_at                                 AS last_sale_at
    FROM page p
    LEFT JOIN public.pack_ask_state pas
      ON p.dist_id IS NOT NULL
     AND pas.dist_id = p.dist_id
     AND pas.collection_slug = replace(p.collection_slug, '_', '-')
    LEFT JOIN public.mv_pack_ev_latest ev
      ON p.dist_id IS NOT NULL
     AND ev.dist_id = p.dist_id AND ev.collection_id = p.collection_id
     -- 2026-09-24: mirror pack_table_rows' publish gates — the MV's sentinel
     -- (gross_ev = 0 AND edition_count = 0) is "could not price", not "$0".
     AND NOT (ev.gross_ev = 0 AND ev.edition_count = 0)
     AND (ev.fmv_coverage_pct IS NULL OR ev.fmv_coverage_pct >= 25)
    LEFT JOIN public.pack_observed_values obs
      ON p.dist_id IS NOT NULL
     AND obs.dist_id = p.dist_id AND obs.collection_id = p.collection_id
     AND obs.n_valued >= 5
    LEFT JOIN LATERAL (
      SELECT pp.sale_price, pp.sealed_at
      FROM public.pack_purchases pp
      WHERE p.dist_id IS NOT NULL
        AND pp.pack_dist_id = p.dist_id
        AND pp.collection_id = p.collection_id
        AND pp.event_kind = 'secondary_sale'
        AND pp.sale_price IS NOT NULL
      ORDER BY pp.sealed_at DESC
      LIMIT 1
    ) lsale ON true
  )
  SELECT
    (SELECT COUNT(*) FROM filtered),
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'pack_nft_id', pack_nft_id, 'collection_id', collection_id,
        'collection_slug', collection_slug, 'collection_name', collection_name,
        'status', status, 'has_buy', has_buy, 'has_sell', has_sell, 'has_rip', has_rip,
        'latest_event_at', latest_event_at, 'first_event_at', first_event_at,
        'pack_name', pack_name, 'pack_image', pack_image, 'pack_tier', pack_tier,
        'dist_id', dist_id, 'dist_source', dist_source,
        'dist_total_sealed', dist_total_sealed, 'dist_total_opened', dist_total_opened,
        'current_owner', current_owner, 'identity_status', identity_status,
        'identity_checked_at', identity_checked_at,
        -- Provenance for the two fields above. true = the index still names this
        -- wallet but its last clean walk did not return the pack, so
        -- identity_status is a LAST-SEEN and not a now; false = that walk
        -- confirmed it; null = no identity row, or no clean walk to judge by.
        'identity_departed', index_departed,
        'rip_id', rip_id, 'ripped_at', ripped_at,
        -- 'rip' (an open event we hold) | 'reconstructed' (a pack opened with no
        -- pack NFT, rebuilt from its moment deliveries) | NULL (not opened here)
        'rip_source', rip_source,
        'moments_pulled', moments_pulled,
        'pull_value_usd', CASE WHEN pull_value_usd IS NULL THEN NULL ELSE ROUND(pull_value_usd::numeric, 2) END,
        -- 'dapper_pulls' | 'rip_record' | NULL; and, when Dapper's list is held,
        -- how many of the pack's moments are identified / priced (so a NULL
        -- value can say "3 of 4 priced" instead of nothing).
        'pull_value_source', pull_value_source,
        'pulls_total', pulls_total, 'pulls_identified', pulls_identified, 'pulls_priced', pulls_priced,
        'buy_price', CASE WHEN buy_price IS NULL THEN NULL ELSE ROUND(buy_price::numeric, 2) END,
        'buy_usd',   CASE WHEN buy_usd   IS NULL THEN NULL ELSE ROUND(buy_usd::numeric, 2) END,
        'buy_price_source', buy_price_source,
        'buy_currency', buy_currency, 'bought_at', bought_at, 'bought_from', bought_from,
        'bought_primary', bought_primary,
        'event_kind', bought_event_kind,
        'sell_price', CASE WHEN sell_price IS NULL THEN NULL ELSE ROUND(sell_price::numeric, 2) END,
        'sell_source', sell_src,
        'sell_currency', sell_currency, 'sold_at', sold_at, 'sold_to', sold_to,
        'realized_pl_usd', CASE WHEN realized_pl_usd IS NULL THEN NULL ELSE ROUND(realized_pl_usd::numeric, 2) END,
        'lowest_ask_usd', CASE WHEN lowest_ask_usd IS NULL THEN NULL ELSE ROUND(lowest_ask_usd::numeric, 2) END,
        'ask_checked_at', ask_checked_at,
        'pack_ev_usd', CASE WHEN pack_ev_usd IS NULL THEN NULL ELSE ROUND(pack_ev_usd::numeric, 2) END,
        'ev_snapshotted_at', ev_snapshotted_at,
        'last_sale_usd', CASE WHEN last_sale_usd IS NULL THEN NULL ELSE ROUND(last_sale_usd::numeric, 2) END,
        'last_sale_at', last_sale_at
      )
      -- 2026-09-26 (v11): when Dapper minted this pack straight into this
      -- wallet (Flow PackNFT.Minted at the index's acquisition instant); NULL =
      -- not known to be (a buy, a transfer, or before the spork floor). A second
      -- object: the one above is at Postgres's 100-argument limit.
      || jsonb_build_object('minted_to_wallet_at', minted_to_wallet_at,
           -- v13: the contents' expected value (gross), beside pack_ev_usd (net of drop price)
           'pack_gross_ev_usd', CASE WHEN pack_gross_ev_usd IS NULL THEN NULL ELSE ROUND(pack_gross_ev_usd::numeric, 2) END,
           -- v14: the mean current value of this drop's opened packs (>= 5 valued), and how many
           'pack_opened_avg_usd', pack_opened_avg_usd, 'pack_opened_n', pack_opened_n,
           -- v15: an All Day pack's mint in Dapper's index, when no marketplace
           -- sale by anyone else precedes this wallet's (mint-on-demand drops:
           -- the purchase itself; a pre-minted drop: days before it opened)
           'primary_minted_at', primary_minted_at,
           -- v18: how many of the pack's pulls are named by inference (id neighbours)
           'pulls_inferred', pulls_inferred,
           -- v19: packs this BOX yielded (0 = not a box)
           'box_packs', box_packs)
      ORDER BY latest_event_at DESC NULLS LAST, collection_id, pack_nft_id
    ), '[]'::jsonb)
  INTO v_total, v_packs
  FROM page_market;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'collection_slug', p_collection_slug,
    'status_filter', p_status,
    'limit', v_safe_limit,
    'offset', v_safe_offset,
    'total_count', v_total,
    'packs', v_packs,
    'identity_sync', v_sync,
    'coverage', jsonb_build_object(
      'onchain', 'pack_purchases: Top Shot + All Day, block-indexed from 2026-04; primary drops carry no price on chain',
      'opens', 'pack_rips (Top Shot, All Day) + golazos_pack_opens + pinnacle_pack_opens',
      'retail', 'buy_price_source = retail_inferred: a pack with no buy row we hold, priced at its drop''s retail -- only when it was acquired inside the drop''s sale window (start_time - 1 day .. + 30 days; acquisition = Dapper''s index date while the index names this wallet, else -- All Day -- the pack''s mint in Dapper''s index (primary_minted_at) when no one else sold it on the marketplace before this wallet''s sale / open, else bounded by the sale / open) and the marketplace history covers that window (every Top Shot PackNFT; All Day drops from 2022-12-16, dates from Dapper''s distribution record), or -- Top Shot -- Dapper minted it straight into this wallet (minted_to_wallet_at; pack_nft_mints, Flow PackNFT.Minted from the 2025-12-29 spork floor). An old drop acquired long after its sale otherwise stays NULL. A transfer inside the window would read the same. A Trade Ticket pack''s price is in tickets, not dollars: NULL. An All Day distribution Dapper types REWARD is $0 (reward); any other All Day price of 0 is unknown. Retail is in dollars (Top Shot UFix64 values normalised; All Day from allday_pack_supply, 0 = unknown)',
      'reconstructed', 'wallet_reconstructed_rips: Top Shot packs opened with NO pack NFT (custodial packs, 2021 on), rebuilt from the wallet''s pack-pull moment deliveries (a gap > 3 s starts a new reveal; 114 of 115 bursts overlapping a known pack matched its moment list exactly). rip_source = reconstructed; no distribution, no price paid; covers deliveries seeded into moment_acquisitions (through 2026-03)',
      'pulls', 'pack_open_pull_values: every pack this wallet opened, priced from the moments Dapper''s searchPackNft.nfts says it yielded (current FMV, whole-pack: NULL unless every moment is priced; pulls_priced / pulls_total say how close; pulls_inferred of them are Top Shot pulls no record names, named from the moment ids minted beside them -- both neighbours the same edition within 50 ids, 99 % right when measured). Refreshed by the wallet-pack-pulls lane; pull_value_source = rip_record where only the rip row''s value is held',
      'marketplace', 'topshot_pack_sales_history / allday_pack_sales_history / golazos_pack_sales_history: Dapper marketplace secondary sales (seller = storefront_address), Top Shot from 2023-09, All Day from 2022-12; ingest is bursty and can lag days',
      'identity', 'pack_nft_identity: Dapper searchPackNft index (dist_id, Sealed/Opened, current owner, acquired_at) filled by the pack-nft-identity lane and the per-wallet sync; identity_sync says when this wallet''s holdings were last confirmed (NULL completed_at = not yet, the list is what we hold so far). An ownership claim is trusted only at or after identity_sync.last_clean_sync_at, the start of the last clean full walk: a row older than that names a pack the wallet no longer holds, is excluded from the held/ripped counts, and carries identity_departed = true'
    ),
    'computed_at', now()
  );
END;
$function$;
