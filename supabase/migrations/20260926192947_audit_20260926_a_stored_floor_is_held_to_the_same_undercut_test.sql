-- A STORED floor the 24 h window no longer re-observes is held to the same undercut test (2026-09-26).
-- 20260926192206 stopped the sync WRITING a 24 h floor undercut by an older open listing under half
-- of it (first tick 12:26 PM PT: undercut_nulled 239). But an edition with NO listing re-observed in
-- 24 h never reaches that upsert (Atlas is not a census), so its old floor stood however far it was
-- undercut — measured ~12:27 PM PT: 996 stored Top Shot floors with an open listing seen within 30 d
-- under half of them, 158 under a tenth; Tre Jones 124:5108 still read $20.00 (no 24 h listing, 69
-- open from $0.20). New step (a0): the same rule on edition_offers.low_ask itself — NULL (unknown),
-- never the older price. Per-row LATERAL ... LIMIT 1 on idx_tame_open_by_edition: 123 ms / 41,687 hit
-- buffers over 13,337 rows on prod (an EXISTS form hash-semi-joined 411k events: 15.5 s — not used).
-- Return gains 'stale_undercut_nulled'. proconfig and EXECUTE grants unchanged (restated).
--
-- REVERT: re-apply the sync_edition_offers_from_atlas body from 20260926192206, re-point the PINS
--         entry and the supabase/tests copy back to it.
-- anon-exec: sync_edition_offers_from_atlas (REVOKED below — already false live, restated because a snapshot must say so)

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'sync_edition_offers_from_atlas' AND pronamespace = 'public'::regnamespace) <> 'c06e1509d17de2d2ac9421dda27e6d20' THEN
    RAISE EXCEPTION 'sync_edition_offers_from_atlas live body is not the 20260926192206 one — re-read before a full-body write';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.sync_edition_offers_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET work_mem TO '16MB'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_undercut int; v_stale int; v_nulled int; v_offers int;
BEGIN
  -- The floor: lowest open ask per edition. DELTA FIRST — the floor is compared against
  -- edition_offers in one join and only new/changed editions reach ON CONFLICT; the guard on
  -- the conflict arm is unchanged. Inside the tick the floor is read off the open book
  -- sync_ts_listings_from_atlas built (same raw rows — the floor never joined editions — same
  -- extra predicate, same ordering); standalone it reads the base tables as before.
  -- ⛔ AN UNDERCUT 24 h FLOOR IS NOT A FLOOR (2026-09-26). The 24 h window is a RE-OBSERVATION
  -- window, and the firehose only re-reports listings that CHANGE (known-issues #85): a quiet
  -- cheap listing ages out of it while newer, dearer ones stay in. So the 24 h minimum can sit
  -- 100x above the real floor — measured 2026-09-26: 241 of 2,713 floor editions had an older
  -- still-open listing under half their 24 h floor; Tre Jones 124:5108 published "lowest ask
  -- $20.00" over 69 open listings from $0.20 and 14 sales at ~$0.21 in 30 d. The older listing
  -- cannot be confirmed live either, so the honest value is UNKNOWN: when an open (not
  -- completed) listing seen within 30 d is under HALF the 24 h minimum, low_ask is written NULL
  -- (a verified-complete settle or a fresh re-observation restores it). Never the older price —
  -- that would publish an unconfirmed ask as the floor.
  IF to_regclass('pg_temp._open24') IS NOT NULL THEN
    WITH floor24 AS (
      SELECT DISTINCT ON (o.external_id)
             o.external_id, o.atlas_edition_id, o.price_cents, o.serial_number, o.nft_id
        FROM _open24 o
       WHERE o.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       ORDER BY o.external_id, o.price_cents ASC, o.serial_number ASC NULLS LAST
    ), floor AS (
      SELECT f.external_id,
             CASE WHEN u.hit THEN NULL ELSE (f.price_cents::numeric / 100) END AS low_ask,
             CASE WHEN u.hit THEN NULL ELSE f.serial_number END AS serial_number,
             CASE WHEN u.hit THEN NULL ELSE f.nft_id END AS nft_id,
             COALESCE(u.hit, false) AS undercut
        FROM floor24 f
        LEFT JOIN LATERAL (
          SELECT true AS hit FROM public.topshot_atlas_market_events ev
           WHERE ev.product = 'nba' AND ev.atlas_edition_id = f.atlas_edition_id
             AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
             AND ev.price_cents > 0 AND ev.price_cents < f.price_cents / 2
             AND ev.last_seen_at > now() - interval '30 days'
           LIMIT 1) u ON true
    ), cand AS (
      SELECT f.*
        FROM floor f
        LEFT JOIN public.edition_offers eo
               ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = f.external_id
       WHERE (eo.external_id IS NULL AND f.low_ask IS NOT NULL)
          OR (eo.external_id IS NOT NULL
              AND (eo.low_ask IS DISTINCT FROM f.low_ask::numeric
                   OR eo.low_ask_nft_id IS DISTINCT FROM f.nft_id))
    ), up AS (
      INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, updated_at)
      SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, now()
        FROM cand f
      ON CONFLICT (collection_id, external_id) DO UPDATE
        SET low_ask = EXCLUDED.low_ask,
            low_ask_serial = EXCLUDED.low_ask_serial,
            low_ask_nft_id = EXCLUDED.low_ask_nft_id,
            updated_at = now()
        WHERE public.edition_offers.low_ask IS DISTINCT FROM EXCLUDED.low_ask
           OR public.edition_offers.low_ask_nft_id IS DISTINCT FROM EXCLUDED.low_ask_nft_id
      RETURNING (public.edition_offers.low_ask IS NULL) AS nulled
    )
    SELECT count(*), count(*) FILTER (WHERE nulled) INTO v_n, v_undercut FROM up;
  ELSE
    WITH floor24 AS (
      SELECT DISTINCT ON (m.external_id)
             m.external_id, ev.atlas_edition_id, ev.price_cents, ev.serial_number, ev.nft_id
        FROM public.topshot_atlas_market_events ev
        JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
       WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
         AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
         AND ev.last_seen_at > now() - interval '24 hours'
         AND m.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       ORDER BY m.external_id, ev.price_cents ASC, ev.serial_number ASC NULLS LAST
    ), floor AS (
      SELECT f.external_id,
             CASE WHEN u.hit THEN NULL ELSE (f.price_cents::numeric / 100) END AS low_ask,
             CASE WHEN u.hit THEN NULL ELSE f.serial_number END AS serial_number,
             CASE WHEN u.hit THEN NULL ELSE f.nft_id END AS nft_id,
             COALESCE(u.hit, false) AS undercut
        FROM floor24 f
        LEFT JOIN LATERAL (
          SELECT true AS hit FROM public.topshot_atlas_market_events ev
           WHERE ev.product = 'nba' AND ev.atlas_edition_id = f.atlas_edition_id
             AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
             AND ev.price_cents > 0 AND ev.price_cents < f.price_cents / 2
             AND ev.last_seen_at > now() - interval '30 days'
           LIMIT 1) u ON true
    ), cand AS (
      SELECT f.*
        FROM floor f
        LEFT JOIN public.edition_offers eo
               ON eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = f.external_id
       WHERE (eo.external_id IS NULL AND f.low_ask IS NOT NULL)
          OR (eo.external_id IS NOT NULL
              AND (eo.low_ask IS DISTINCT FROM f.low_ask::numeric
                   OR eo.low_ask_nft_id IS DISTINCT FROM f.nft_id))
    ), up AS (
      INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, updated_at)
      SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, now()
        FROM cand f
      ON CONFLICT (collection_id, external_id) DO UPDATE
        SET low_ask = EXCLUDED.low_ask,
            low_ask_serial = EXCLUDED.low_ask_serial,
            low_ask_nft_id = EXCLUDED.low_ask_nft_id,
            updated_at = now()
        WHERE public.edition_offers.low_ask IS DISTINCT FROM EXCLUDED.low_ask
           OR public.edition_offers.low_ask_nft_id IS DISTINCT FROM EXCLUDED.low_ask_nft_id
      RETURNING (public.edition_offers.low_ask IS NULL) AS nulled
    )
    SELECT count(*), count(*) FILTER (WHERE nulled) INTO v_n, v_undercut FROM up;
  END IF;

  -- (a0) The same test on a STORED floor. An edition with no listing re-observed in 24 h never
  -- reaches the upsert above (Atlas is not a census), so its old floor stood however far an open
  -- listing had undercut it — measured 2026-09-26 after the step above shipped: 996 stored floors
  -- under an open listing below half (158 below a tenth), Tre Jones 124:5108 among them. Same rule:
  -- NULL (unknown), never the older price. Per-row LATERAL ... LIMIT 1 on idx_tame_open_by_edition
  -- (~120 ms / 42k hit buffers on prod); an EXISTS here hash-semi-joins 411k events (15 s).
  WITH hit AS (
    SELECT DISTINCT eo.external_id
      FROM public.edition_offers eo
      JOIN public.topshot_atlas_edition_map m ON m.external_id = eo.external_id
     CROSS JOIN LATERAL (
       SELECT 1 FROM public.topshot_atlas_market_events ev
        WHERE ev.product = 'nba' AND ev.atlas_edition_id = m.atlas_edition_id
          AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
          AND ev.price_cents > 0 AND ev.price_cents < (eo.low_ask * 100)::bigint / 2
          AND ev.last_seen_at > now() - interval '30 days'
        LIMIT 1) u
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.low_ask IS NOT NULL
  ), stale AS (
    UPDATE public.edition_offers eo
       SET low_ask = NULL, low_ask_serial = NULL, low_ask_nft_id = NULL, updated_at = now()
      FROM hit h
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = h.external_id
       AND eo.low_ask IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_stale FROM stale;

  -- (a) evidence-based NULL: verified COMPLETE within 24 h, and no open listing remains.
  WITH gone AS (
    SELECT m.external_id
      FROM public.topshot_atlas_edition_verified v
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = v.atlas_edition_id
     WHERE v.complete AND v.verified_at > now() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                        WHERE ev.product = 'nba' AND ev.atlas_edition_id = v.atlas_edition_id
                          AND ev.kind = 'listing' AND NOT ev.completed AND ev.price_cents > 0)
  ), nulled AS (
    UPDATE public.edition_offers eo
       SET low_ask = NULL, low_ask_serial = NULL, low_ask_nft_id = NULL, updated_at = now()
      FROM gone g
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = g.external_id
       AND eo.low_ask IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_nulled FROM nulled;

  -- (b) highest_offer for editions verified within 24 h: MAX open EDITION/PARALLEL offer, else NULL
  --     when the verification was complete. Serial offers are not an edition's offer.
  WITH ver AS (
    SELECT m.external_id, v.complete,
           (SELECT max(ev.price_cents) FROM public.topshot_atlas_market_events ev
             WHERE ev.product = 'nba' AND ev.atlas_edition_id = v.atlas_edition_id AND ev.kind = 'offer'
               AND NOT ev.completed AND ev.offer_type IN ('EDITION', 'PARALLEL') AND ev.price_cents > 0
               AND ev.last_seen_at > now() - interval '24 hours') AS best_cents
      FROM public.topshot_atlas_edition_verified v
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = v.atlas_edition_id
     WHERE v.verified_at > now() - interval '24 hours'
       AND m.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ), off AS (
    INSERT INTO public.edition_offers (collection_id, external_id, highest_offer, updated_at)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', ver.external_id, ver.best_cents::numeric / 100, now()
      FROM ver
     WHERE ver.best_cents IS NOT NULL
    ON CONFLICT (collection_id, external_id) DO UPDATE
      SET highest_offer = EXCLUDED.highest_offer, updated_at = now()
      WHERE public.edition_offers.highest_offer IS DISTINCT FROM EXCLUDED.highest_offer
    RETURNING 1
  ), off_null AS (
    UPDATE public.edition_offers eo
       SET highest_offer = NULL, updated_at = now()
      FROM ver
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND eo.external_id = ver.external_id
       AND ver.complete AND ver.best_cents IS NULL AND eo.highest_offer IS NOT NULL
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM off) + (SELECT count(*) FROM off_null) INTO v_offers;

  RETURN jsonb_build_object('rows', v_n, 'undercut_nulled', v_undercut, 'stale_undercut_nulled', v_stale, 'nulled', v_nulled, 'offers', v_offers,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

REVOKE ALL ON FUNCTION public.sync_edition_offers_from_atlas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_edition_offers_from_atlas() TO service_role;
