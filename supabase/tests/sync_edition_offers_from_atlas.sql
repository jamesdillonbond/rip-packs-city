-- DB invariant: public.sync_edition_offers_from_atlas — Top Shot's per-edition lowest ask,
-- refreshed from the Atlas marketplace firehose after the GQL offers-sweep host died (2026-09-07).
-- edition_offers.low_ask is the "lowest ask" on the collection grid, moment and edition pages and
-- fmv-recalc's ask feed; a regression here either publishes a stale/higher floor as current or
-- NULLs an edition Atlas simply has not seen.
--
-- Pins:
--   * the floor is the MIN open, verified (24 h) listing price per canonical external_id, with
--     that listing's serial + nft id beside it;
--   * ...UNLESS an open listing seen within 30 d is under HALF of it: then the 24 h minimum is not
--     the floor and low_ask is NULL (unknown), never the older unconfirmed price (2026-09-26);
--   * the same test NULLs a STORED floor the 24 h window no longer re-observes (2026-09-26);
--   * a parallel's listings land on the `::sub` row, never the base row;
--   * an edition with NO open listing in our events is left untouched (Atlas is not a census);
--   * completed listings, unverified listings and inert (non-canonical) keys never contribute;
--   * a stale ask is NULLed ONLY for an edition verified COMPLETE within 24 h with no open listing;
--   * highest_offer = MAX open EDITION/PARALLEL offer for editions verified within 24 h (SERIAL and
--     completed offers never count), NULLed when verified complete with none open;
--   * a re-run over unchanged data writes 0 rows (WHERE guards);
--   * low_ask_confirmed_at is the floor listing's last OBSERVATION: a changed floor takes its listing's
--     last_seen_at, an unchanged floor re-observed is moved forward to it, a NULL ask has none, and an
--     offer-only write never touches it (audit_20260930).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261001030000_audit_20260930_topshot_alert_asks_are_rechecked_before_they_are_sent.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.topshot_atlas_market_events (
  uuid text PRIMARY KEY, product text, kind text, offer_type text, completed boolean, nft_id text, atlas_edition_id text,
  serial_number integer, price_cents bigint, last_seen_at timestamptz);
CREATE TABLE public.topshot_atlas_edition_verified (atlas_edition_id text PRIMARY KEY, verified_at timestamptz, complete boolean);
CREATE TABLE public.topshot_atlas_edition_map (atlas_edition_id text PRIMARY KEY, external_id text);
CREATE TABLE public.edition_offers (
  collection_id uuid, external_id text, highest_offer numeric, low_ask numeric, updated_at timestamptz,
  low_ask_serial integer, low_ask_nft_id text, PRIMARY KEY (collection_id, external_id));
-- audit_20260930: the confirmation column and the trigger that keeps every writer honest.
ALTER TABLE public.edition_offers ADD COLUMN low_ask_confirmed_at timestamptz;

-- >>> BEGIN verbatim edition_offers_stamp_low_ask_confirmed (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.edition_offers_stamp_low_ask_confirmed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- No ask, no confirmation.
  IF NEW.low_ask IS NULL THEN
    NEW.low_ask_confirmed_at := NULL;
  -- A writer that names no confirmation time is confirming the ask NOW (the
  -- old updated_at contract), so every other writer of low_ask keeps working.
  ELSIF TG_OP = 'INSERT' THEN
    NEW.low_ask_confirmed_at := COALESCE(NEW.low_ask_confirmed_at, now());
  -- The ask CHANGED and the writer did not say when it was observed: now().
  -- An offer-only write (highest_offer) never reaches this arm, so it can no
  -- longer make an old ask look freshly confirmed.
  ELSIF (NEW.low_ask IS DISTINCT FROM OLD.low_ask OR NEW.low_ask_nft_id IS DISTINCT FROM OLD.low_ask_nft_id)
        AND NEW.low_ask_confirmed_at IS NOT DISTINCT FROM OLD.low_ask_confirmed_at THEN
    NEW.low_ask_confirmed_at := now();
  END IF;
  RETURN NEW;
END
$function$;
-- <<< END verbatim edition_offers_stamp_low_ask_confirmed <<<
CREATE TRIGGER trg_edition_offers_stamp_low_ask_confirmed
  BEFORE INSERT OR UPDATE ON public.edition_offers
  FOR EACH ROW EXECUTE FUNCTION public.edition_offers_stamp_low_ask_confirmed();

-- >>> BEGIN verbatim sync_edition_offers_from_atlas (keep byte-identical to the migration) >>>

CREATE OR REPLACE FUNCTION public.sync_edition_offers_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET work_mem TO '16MB'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_undercut int; v_stale int; v_nulled int; v_offers int; v_reconfirmed int;
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
             o.external_id, o.atlas_edition_id, o.price_cents, o.serial_number, o.nft_id, o.last_seen_at
        FROM _open24 o
       WHERE o.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       ORDER BY o.external_id, o.price_cents ASC, o.serial_number ASC NULLS LAST
    ), floor AS (
      SELECT f.external_id,
             CASE WHEN u.hit THEN NULL ELSE (f.price_cents::numeric / 100) END AS low_ask,
             CASE WHEN u.hit THEN NULL ELSE f.serial_number END AS serial_number,
             CASE WHEN u.hit THEN NULL ELSE f.nft_id END AS nft_id,
             -- audit_20260930: WHEN this floor listing was last OBSERVED -- the ask's
             -- confirmation time, never the write time (a 23 h-old listing is not news).
             CASE WHEN u.hit THEN NULL ELSE f.last_seen_at END AS seen_at,
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
      INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, low_ask_confirmed_at, updated_at)
      SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, f.seen_at, now()
        FROM cand f
      ON CONFLICT (collection_id, external_id) DO UPDATE
        SET low_ask = EXCLUDED.low_ask,
            low_ask_serial = EXCLUDED.low_ask_serial,
            low_ask_nft_id = EXCLUDED.low_ask_nft_id,
            low_ask_confirmed_at = EXCLUDED.low_ask_confirmed_at,
            updated_at = now()
        WHERE public.edition_offers.low_ask IS DISTINCT FROM EXCLUDED.low_ask
           OR public.edition_offers.low_ask_nft_id IS DISTINCT FROM EXCLUDED.low_ask_nft_id
      RETURNING (public.edition_offers.low_ask IS NULL) AS nulled
    )
    SELECT count(*), count(*) FILTER (WHERE nulled) INTO v_n, v_undercut FROM up;
  ELSE
    WITH floor24 AS (
      SELECT DISTINCT ON (m.external_id)
             m.external_id, ev.atlas_edition_id, ev.price_cents, ev.serial_number, ev.nft_id, ev.last_seen_at
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
             -- audit_20260930: WHEN this floor listing was last OBSERVED -- the ask's
             -- confirmation time, never the write time (a 23 h-old listing is not news).
             CASE WHEN u.hit THEN NULL ELSE f.last_seen_at END AS seen_at,
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
      INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, low_ask_confirmed_at, updated_at)
      SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, f.seen_at, now()
        FROM cand f
      ON CONFLICT (collection_id, external_id) DO UPDATE
        SET low_ask = EXCLUDED.low_ask,
            low_ask_serial = EXCLUDED.low_ask_serial,
            low_ask_nft_id = EXCLUDED.low_ask_nft_id,
            low_ask_confirmed_at = EXCLUDED.low_ask_confirmed_at,
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

  -- (a1) audit_20260930: RE-CONFIRMATION. The upsert above writes only a CHANGED floor, so an
  -- ask Atlas re-observed unchanged kept its old stamp, and the alert gate and every "ask seen
  -- Nh ago" read the age of the last CHANGE. When the exact floor listing (same nft, same price,
  -- still open) has been seen since the stored confirmation, move the confirmation forward to
  -- that observation. Reads a 30-min slice of idx_tame_open_listing_by_seen; a tick that misses
  -- a re-observation leaves the stamp OLDER (fail-closed), never newer.
  WITH seen AS (
    SELECT ev.nft_id, ev.price_cents, max(ev.last_seen_at) AS seen_at
      FROM public.topshot_atlas_market_events ev
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
       AND ev.last_seen_at > now() - interval '30 minutes'
     GROUP BY ev.nft_id, ev.price_cents
  ), re AS (
    UPDATE public.edition_offers eo
       SET low_ask_confirmed_at = s.seen_at
      FROM seen s
     WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND eo.low_ask IS NOT NULL
       AND eo.low_ask_nft_id = s.nft_id
       AND (eo.low_ask * 100)::bigint = s.price_cents
       AND (eo.low_ask_confirmed_at IS NULL OR eo.low_ask_confirmed_at < s.seen_at)
    RETURNING 1
  )
  SELECT count(*) INTO v_reconfirmed FROM re;

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

  RETURN jsonb_build_object('rows', v_n, 'undercut_nulled', v_undercut, 'stale_undercut_nulled', v_stale, 'nulled', v_nulled, 'offers', v_offers, 'reconfirmed', v_reconfirmed,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

-- <<< END verbatim sync_edition_offers_from_atlas <<<

INSERT INTO public.topshot_atlas_edition_map VALUES ('E1', '99:3372'), ('E2', '99:3372::17'), ('E3', 'a1b2c3d4-0000-4000-8000-000000000000:x');
INSERT INTO public.topshot_atlas_market_events (uuid, product, kind, completed, nft_id, atlas_edition_id, serial_number, price_cents, last_seen_at) VALUES
  ('u1', 'nba', 'listing', false, 'N1', 'E1', 4521, 1250, now() - interval '1 hour'),   -- $12.50
  ('u2', 'nba', 'listing', false, 'N2', 'E1', 12,   900,  now() - interval '2 hours'),  -- $9.00 ← the floor
  ('u3', 'nba', 'listing', false, 'N3', 'E1', 3,    600,  now() - interval '30 hours'), -- $6 but UNVERIFIED (not under half the floor, so no undercut)
  ('u4', 'nba', 'listing', true,  'N4', 'E1', 4,    50,   now() - interval '1 hour'),   -- $0.50 but SOLD
  ('u5', 'nba', 'listing', false, 'N5', 'E2', 17,   99900, now() - interval '1 hour'),  -- the parallel
  ('u6', 'nba', 'listing', false, 'N6', 'E3', 1,    10,   now() - interval '1 hour');   -- inert key
-- E5 '5:5': a $20 listing re-seen in 24 h over an OLDER still-open $0.20 listing (the 124:5108 case) -> NULL.
-- E6 '6:6': a $5 floor with a $0.10 open listing last seen 40 days ago (outside the 30 d window) -> $5 stands.
INSERT INTO public.topshot_atlas_edition_map VALUES ('E5', '5:5'), ('E6', '6:6');
INSERT INTO public.topshot_atlas_market_events (uuid, product, kind, completed, nft_id, atlas_edition_id, serial_number, price_cents, last_seen_at) VALUES
  ('u7', 'nba', 'listing', false, 'N7', 'E5', 2182, 2000, now() - interval '1 hour'),
  ('u8', 'nba', 'listing', false, 'N8', 'E5', 90,   20,   now() - interval '5 days'),
  ('u9', 'nba', 'listing', false, 'N9', 'E6', 50,   500,  now() - interval '1 hour'),
  ('u10','nba', 'listing', false, 'N10','E6', 51,   10,   now() - interval '40 days');
-- E8 '8:8': a STORED $30 floor, nothing re-seen in 24 h, an open $1 listing seen 10 days ago -> NULL.
-- E9 '9:9': a STORED $30 floor, nothing re-seen in 24 h, an open $20 listing (not under half) -> $30 stands, untouched.
INSERT INTO public.topshot_atlas_edition_map VALUES ('E8', '8:8'), ('E9', '9:9');
INSERT INTO public.topshot_atlas_market_events (uuid, product, kind, completed, nft_id, atlas_edition_id, serial_number, price_cents, last_seen_at) VALUES
  ('u11','nba', 'listing', false, 'N11','E8', 60,   100,  now() - interval '10 days'),
  ('u12','nba', 'listing', false, 'N12','E9', 61,   2000, now() - interval '10 days');
-- E10 '10:10' (audit_20260930): a STORED $3 floor whose exact listing (N13, same price) Atlas
-- re-observed 5 min ago. The floor does not change, so the upsert never touches it — only the
-- re-confirmation step can move its stamp, and it must move it to the OBSERVATION, not now().
INSERT INTO public.topshot_atlas_edition_map VALUES ('E10', '10:10');
INSERT INTO public.topshot_atlas_market_events (uuid, product, kind, completed, nft_id, atlas_edition_id, serial_number, price_cents, last_seen_at) VALUES
  ('u13','nba', 'listing', false, 'N13','E10', 70,   300,  now() - interval '5 minutes');
-- offers: an open EDITION offer and a SERIAL offer on E1 (serial offers are not an edition's offer),
-- an open PARALLEL offer on E2; E4 ('7:7') has a stale ask + offer and is VERIFIED COMPLETE with nothing open.
INSERT INTO public.topshot_atlas_edition_map VALUES ('E4', '7:7');
INSERT INTO public.topshot_atlas_market_events (uuid, product, kind, offer_type, completed, nft_id, atlas_edition_id, serial_number, price_cents, last_seen_at) VALUES
  ('o1', 'nba', 'offer', 'EDITION',  false, NULL, 'E1', NULL, 700, now() - interval '1 hour'),
  ('o2', 'nba', 'offer', 'SERIAL',   false, 'N1', 'E1', 4521, 5000, now() - interval '1 hour'),
  ('o3', 'nba', 'offer', 'EDITION',  true,  NULL, 'E1', NULL, 9000, now() - interval '1 hour'),
  ('o4', 'nba', 'offer', 'PARALLEL', false, NULL, 'E2', NULL, 30000, now() - interval '1 hour');
INSERT INTO public.topshot_atlas_edition_verified VALUES ('E1', now() - interval '1 hour', true), ('E2', now() - interval '1 hour', false), ('E4', now() - interval '1 hour', true);
INSERT INTO public.edition_offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '99:3372', 6.00, 40.00, '2026-08-28', NULL, NULL),  -- stale ask (higher) and stale offer
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1',     3.00, 55.00, '2026-08-28', NULL, NULL),  -- Atlas has not seen it
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '7:7',     2.00, 12.00, '2026-08-28', 9, 'OLD'),    -- verified COMPLETE, nothing open
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '5:5',     NULL, 20.00, '2026-08-28', 2182, 'N7'),  -- published the undercut $20 floor
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8:8',     NULL, 30.00, '2026-08-28', 7, 'OLD8'),   -- stored floor, undercut, no 24 h listing
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '9:9',     NULL, 30.00, '2026-08-28', 8, 'OLD9'),   -- stored floor, NOT undercut
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '10:10',   NULL, 3.00,  '2026-08-28', 70, 'N13');   -- unchanged floor, re-observed
UPDATE public.edition_offers SET low_ask_confirmed_at = '2026-08-28' WHERE external_id = '10:10';

SELECT _assert_eq((SELECT j->>'rows' || '/' || (j->>'undercut_nulled') || '/' || (j->>'stale_undercut_nulled') || '/' || (j->>'nulled') || '/' || (j->>'offers') || '/' || (j->>'reconfirmed') FROM (SELECT public.sync_edition_offers_from_atlas() j) s), '4/1/1/1/3/1',
  'one re-confirmation (10:10); four floor writes (99:3372, its ::17, 5:5 NULLed as undercut, 6:6 new), one STORED floor NULLed as undercut (8:8), one stale ask NULLed on evidence, three highest_offer writes');
SELECT _assert_eq((SELECT coalesce(low_ask::text, 'null') || '/' || coalesce(low_ask_serial::text, 'null') || '/' || coalesce(low_ask_nft_id, 'null') FROM public.edition_offers WHERE external_id = '8:8'), 'null/null/null',
  'a STORED floor with no 24 h re-observation, undercut by an open listing under half of it, is NULLed — not left standing because Atlas did not re-report it');
SELECT _assert_eq((SELECT round(low_ask, 2)::text || '/' || low_ask_nft_id || '/' || updated_at::date FROM public.edition_offers WHERE external_id = '9:9'), '30.00/OLD9/2026-08-28',
  'a stored floor whose cheapest open listing is NOT under half of it is left exactly as it was');
SELECT _assert_eq((SELECT coalesce(low_ask::text, 'null') || '/' || coalesce(low_ask_serial::text, 'null') || '/' || coalesce(low_ask_nft_id, 'null') FROM public.edition_offers WHERE external_id = '5:5'), 'null/null/null',
  'a 24 h floor undercut by an open listing under half of it is NOT published — unknown, not $20 and not the unconfirmed $0.20');
SELECT _assert_eq((SELECT round(low_ask, 2)::text || '/' || low_ask_serial FROM public.edition_offers WHERE external_id = '6:6'), '5.00/50',
  'a cheaper open listing last seen outside 30 d does not undercut: the 24 h floor stands');
SELECT _assert_eq((SELECT round(low_ask, 2)::text || '/' || low_ask_serial || '/' || low_ask_nft_id || '/' || round(highest_offer, 2)::text FROM public.edition_offers WHERE external_id = '99:3372'),
  '9.00/12/N2/7.00', 'floor = min OPEN VERIFIED listing, with its serial + nft; highest_offer = the open EDITION offer, not the SERIAL one nor the completed $90');
SELECT _assert((SELECT updated_at > now() - interval '1 minute' FROM public.edition_offers WHERE external_id = '99:3372'), 'refreshed row carries a fresh updated_at');
SELECT _assert_eq((SELECT round(low_ask, 2)::text || '/' || low_ask_serial || '/' || round(highest_offer, 2)::text FROM public.edition_offers WHERE external_id = '99:3372::17'), '999.00/17/300.00', 'the parallel lands on its ::sub row with its own PARALLEL offer');
SELECT _assert_eq((SELECT coalesce(low_ask::text, 'null') || '/' || coalesce(low_ask_nft_id, 'null') || '/' || coalesce(highest_offer::text, 'null') FROM public.edition_offers WHERE external_id = '7:7'), 'null/null/null',
  'verified COMPLETE with nothing open: the stale ask AND the stale offer are NULLed — on evidence, not age');
SELECT _assert_eq((SELECT round(low_ask, 2)::text || '/' || updated_at::date FROM public.edition_offers WHERE external_id = '1:1'), '55.00/2026-08-28', 'an edition Atlas has not seen is left exactly as it was — never NULLed');
SELECT _assert((SELECT NOT EXISTS (SELECT 1 FROM public.edition_offers WHERE external_id LIKE 'a1b2c3d4%')), 'an inert uuid-keyed map row never writes a floor');
-- ── audit_20260930: low_ask_confirmed_at means WHEN THE FLOOR LISTING WAS LAST OBSERVED ─────────
SELECT _assert((SELECT low_ask_confirmed_at BETWEEN now() - interval '2 hours 1 minute' AND now() - interval '1 hour 59 minutes'
                  FROM public.edition_offers WHERE external_id = '99:3372'),
  'a CHANGED floor is stamped with its listing''s last observation (2 h ago), never the write time -- and the offer write in the same run did not move it');
SELECT _assert((SELECT low_ask_confirmed_at BETWEEN now() - interval '6 minutes' AND now() - interval '4 minutes'
                  FROM public.edition_offers WHERE external_id = '10:10'),
  'an UNCHANGED floor whose exact listing was re-observed is re-confirmed to that observation (5 min ago), not left at its last change');
SELECT _assert_eq((SELECT count(*)::text FROM public.edition_offers WHERE external_id IN ('5:5', '7:7', '8:8') AND low_ask_confirmed_at IS NULL), '3',
  'a NULLed ask carries no confirmation');
SELECT _assert_eq((SELECT low_ask_confirmed_at::date::text FROM public.edition_offers WHERE external_id = '9:9'), current_date::text,
  'a writer that inserts an ask without naming an observation confirms it NOW (the trigger keeps the old contract for other writers)');
-- an offer-only write must NOT refresh an old ask's confirmation (the raise_edition_offers_from_chain shape)
UPDATE public.edition_offers SET low_ask_confirmed_at = '2026-08-28' WHERE external_id = '10:10';
UPDATE public.edition_offers SET highest_offer = 2.50, updated_at = now() WHERE external_id = '10:10';
SELECT _assert_eq((SELECT low_ask_confirmed_at::date::text FROM public.edition_offers WHERE external_id = '10:10'), '2026-08-28',
  'an OFFER-only write leaves the ask''s confirmation exactly where it was');
UPDATE public.edition_offers SET low_ask = 2.75 WHERE external_id = '10:10';
SELECT _assert((SELECT low_ask_confirmed_at > now() - interval '1 minute' FROM public.edition_offers WHERE external_id = '10:10'),
  'while an ASK change by a writer naming no observation time is confirmed now');
UPDATE public.edition_offers SET low_ask = 3.00, low_ask_confirmed_at = now() - interval '5 minutes' WHERE external_id = '10:10';
SELECT _assert_eq((SELECT j->>'rows' || '/' || (j->>'undercut_nulled') || '/' || (j->>'stale_undercut_nulled') || '/' || (j->>'nulled') || '/' || (j->>'offers') || '/' || (j->>'reconfirmed') FROM (SELECT public.sync_edition_offers_from_atlas() j) s), '0/0/0/0/0/0', 'a second run over unchanged data writes nothing (an undercut NULL is stable; a confirmation never moves backwards or re-writes itself)');

ROLLBACK;
