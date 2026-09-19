-- DB invariant: public.sync_ts_listings_from_atlas — the Top Shot sniper's serial-grain
-- feed (ts_listings), rebuilt every 2 min from the Atlas marketplace firehose
-- (2026-09-07). A regression here either hides deals (rows dropped) or, worse, shows a
-- listing that is gone or misidentified — a reader clicks a "deal" that does not exist.
--
-- Pins:
--   * only OPEN nba listings (kind='listing', NOT completed) reach ts_listings;
--   * a listing not VERIFIED in the last 24 h (last_seen_at) is withheld;
--   * an open listing whose edition is UNMAPPED is withheld and COUNTED, never guessed;
--   * one row per Moment — the NEWEST listing wins when a relisted Moment carries a
--     superseded "open" listing;
--   * the parallel's subedition id is parsed from the mapped edition's `::N`; a
--     Standard printing keys 0;
--   * price_cents → price_usd; a team highlight falls back to team_name; the
--     return payload counts rows / unverified / unmapped.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260919152824_audit_20260919_r101_v2_atlas_listing_tick_scans_the_open_book_once_and_upserts_only_the_delta.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures (only the columns the function reads/writes) ─────────────
CREATE TABLE public.topshot_atlas_market_events (
  uuid text PRIMARY KEY, product text, kind text, completed boolean, nft_id text, atlas_edition_id text,
  set_id_onchain integer, play_id_onchain integer, serial_number integer, price_cents bigint,
  seller_address text, tier text, listed_at timestamptz, last_seen_at timestamptz,
  listing_resource_id text);  -- read into _open24 (2026-09-18); appended so positional inserts stay valid
CREATE TABLE public.topshot_atlas_edition_map (atlas_edition_id text PRIMARY KEY, rpc_edition_id uuid, external_id text);
CREATE TABLE public.editions (id uuid PRIMARY KEY, player_name text, team_name text, set_name text, tier text, series smallint, circulation_count integer,
  thumbnail_url text);  -- read into _open24 (2026-09-18); appended so positional inserts stay valid
CREATE TABLE public.ts_listings (
  listing_id text PRIMARY KEY, flow_id text, set_id integer, play_id integer, parallel_id integer, serial_number integer,
  circulation_count integer, price_usd numeric, seller_address text, player_name text, set_name text, moment_tier text,
  series_number integer, is_locked boolean, asset_path_prefix text, ingested_at timestamptz, listed_at timestamptz);

-- >>> BEGIN verbatim sync_ts_listings_from_atlas (keep byte-identical to the migration) >>>

CREATE OR REPLACE FUNCTION public.sync_ts_listings_from_atlas(p_diag boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_ins int; v_upd int; v_del int; v_unverified int; v_unmapped int;
BEGIN
  -- Diagnostics: open nba listings we could not map to an edition are counted, never guessed
  -- at, and listings the verify probes have not re-seen in 24 h are counted the same way.
  -- Both are slow-moving stocks read off a ~400k-row index (42k + 23k buffers per read), so
  -- the tick SAMPLES them (p_diag) — an unsampled tick publishes NULL, never 0.
  IF p_diag THEN
    SELECT count(*) INTO v_unmapped
      FROM public.topshot_atlas_market_events ev
      LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND m.rpc_edition_id IS NULL;
    SELECT count(*) INTO v_unverified
      FROM public.topshot_atlas_market_events ev
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.last_seen_at <= now() - interval '24 hours';
  END IF;

  -- The open book, built ONCE per transaction: every open, verified-in-24h, MAPPED nba listing
  -- with a price — the event and map columns only (slim: the 09-18 version carried editions'
  -- columns too and spilled its local buffers). Raw rows — one Moment may carry several (a
  -- relisted Moment keeps its superseded listing "open" until the verify probe flips it); each
  -- consumer applies its own editions join, DISTINCT ON and ordering below, exactly as it did
  -- against the base tables.
  DROP TABLE IF EXISTS _open24;  -- a caller may run the sync twice in one transaction (the pin does)
  CREATE TEMP TABLE _open24 ON COMMIT DROP AS
  SELECT ev.uuid, ev.nft_id, ev.atlas_edition_id, ev.set_id_onchain, ev.play_id_onchain, ev.serial_number,
         ev.price_cents, ev.seller_address, ev.tier AS ev_tier, ev.listed_at, ev.last_seen_at, ev.listing_resource_id,
         m.external_id, m.rpc_edition_id
    FROM public.topshot_atlas_market_events ev
    JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
     AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
     AND ev.last_seen_at > now() - interval '24 hours';

  -- The wanted set. One row per Moment: the NEWEST listing per nft wins.
  DROP TABLE IF EXISTS _tsl_want;
  CREATE TEMP TABLE _tsl_want ON COMMIT DROP AS
  SELECT DISTINCT ON (o.nft_id)
         o.uuid AS listing_id, o.nft_id AS flow_id, o.set_id_onchain AS set_id, o.play_id_onchain AS play_id,
         COALESCE(NULLIF(split_part(o.external_id, '::', 2), '')::int, 0) AS parallel_id,
         o.serial_number, e.circulation_count, (o.price_cents::numeric / 100) AS price_usd,
         o.seller_address, COALESCE(e.player_name, e.team_name) AS player_name, e.set_name,
         COALESCE(o.ev_tier, e.tier::text) AS moment_tier, e.series AS series_number,
         false AS is_locked, NULL::text AS asset_path_prefix, o.last_seen_at AS ingested_at, o.listed_at
    FROM _open24 o
    JOIN public.editions e ON e.id = o.rpc_edition_id
   ORDER BY o.nft_id, o.listed_at DESC NULLS LAST;
  SELECT count(*) INTO v_n FROM _tsl_want;

  -- Gone: rows no longer in the wanted set (sold, cancelled by a verify read, aged out of the window,
  -- or superseded by a newer listing of the same Moment — the newer one's listing_id replaces it).
  DELETE FROM public.ts_listings t WHERE NOT EXISTS (SELECT 1 FROM _tsl_want w WHERE w.listing_id = t.listing_id);
  GET DIAGNOSTICS v_del = ROW_COUNT;

  -- New and changed. DELTA FIRST: one hash join against ts_listings names the rows that are new
  -- or differ (compared as the target's own column types), and only those reach ON CONFLICT —
  -- which used to probe every one of the ~55k wanted rows to write ~60. The guard on the
  -- conflict arm is unchanged, so the pre-filter can only narrow what is offered, never widen
  -- what is written.
  WITH cand AS (
    SELECT w.*
      FROM _tsl_want w
      LEFT JOIN public.ts_listings t ON t.listing_id = w.listing_id
     WHERE t.listing_id IS NULL
        OR (t.flow_id, t.set_id, t.play_id, t.parallel_id, t.serial_number, t.circulation_count, t.price_usd,
            t.seller_address, t.player_name, t.set_name, t.moment_tier, t.series_number, t.is_locked,
            t.asset_path_prefix, t.ingested_at, t.listed_at)
           IS DISTINCT FROM
           (w.flow_id, w.set_id::integer, w.play_id::integer, w.parallel_id::integer, w.serial_number::integer,
            w.circulation_count::integer, w.price_usd::numeric(12,4), w.seller_address, w.player_name, w.set_name,
            w.moment_tier, w.series_number::integer, w.is_locked::boolean, w.asset_path_prefix,
            w.ingested_at::timestamptz, w.listed_at::timestamptz)
  ), up AS (
    INSERT INTO public.ts_listings (listing_id, flow_id, set_id, play_id, parallel_id, serial_number, circulation_count, price_usd,
                                    seller_address, player_name, set_name, moment_tier, series_number, is_locked, asset_path_prefix,
                                    ingested_at, listed_at)
    SELECT w.listing_id, w.flow_id, w.set_id, w.play_id, w.parallel_id, w.serial_number, w.circulation_count, w.price_usd,
           w.seller_address, w.player_name, w.set_name, w.moment_tier, w.series_number, w.is_locked, w.asset_path_prefix,
           w.ingested_at, w.listed_at
      FROM cand w
    ON CONFLICT (listing_id) DO UPDATE
      SET flow_id = EXCLUDED.flow_id, set_id = EXCLUDED.set_id, play_id = EXCLUDED.play_id, parallel_id = EXCLUDED.parallel_id,
          serial_number = EXCLUDED.serial_number, circulation_count = EXCLUDED.circulation_count, price_usd = EXCLUDED.price_usd,
          seller_address = EXCLUDED.seller_address, player_name = EXCLUDED.player_name, set_name = EXCLUDED.set_name,
          moment_tier = EXCLUDED.moment_tier, series_number = EXCLUDED.series_number, is_locked = EXCLUDED.is_locked,
          asset_path_prefix = EXCLUDED.asset_path_prefix, ingested_at = EXCLUDED.ingested_at, listed_at = EXCLUDED.listed_at
      WHERE (public.ts_listings.flow_id, public.ts_listings.set_id, public.ts_listings.play_id, public.ts_listings.parallel_id,
             public.ts_listings.serial_number, public.ts_listings.circulation_count, public.ts_listings.price_usd,
             public.ts_listings.seller_address, public.ts_listings.player_name, public.ts_listings.set_name,
             public.ts_listings.moment_tier, public.ts_listings.series_number, public.ts_listings.is_locked,
             public.ts_listings.asset_path_prefix, public.ts_listings.ingested_at, public.ts_listings.listed_at)
            IS DISTINCT FROM
            (EXCLUDED.flow_id, EXCLUDED.set_id, EXCLUDED.play_id, EXCLUDED.parallel_id, EXCLUDED.serial_number,
             EXCLUDED.circulation_count, EXCLUDED.price_usd, EXCLUDED.seller_address, EXCLUDED.player_name, EXCLUDED.set_name,
             EXCLUDED.moment_tier, EXCLUDED.series_number, EXCLUDED.is_locked, EXCLUDED.asset_path_prefix,
             EXCLUDED.ingested_at, EXCLUDED.listed_at)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted) INTO v_ins, v_upd FROM up;

  RETURN jsonb_build_object('rows', v_n, 'inserted', v_ins, 'updated', v_upd, 'deleted', v_del,
                            'unverified_24h', v_unverified, 'unmapped', v_unmapped, 'diag_sampled', p_diag,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

-- <<< END verbatim sync_ts_listings_from_atlas <<<

-- ── fixtures ──────────────────────────────────────────────────────────────────
INSERT INTO public.editions VALUES
  ('00000000-0000-4000-8000-000000000001', 'Ja Morant', 'Grizzlies', 'Base Set', 'COMMON', 7, 15000),
  ('00000000-0000-4000-8000-000000000002', 'Ja Morant', 'Grizzlies', 'Base Set', 'RARE',   7,   250),   -- the ::17 parallel
  ('00000000-0000-4000-8000-000000000003', NULL,        'Kings',     'Clamps',   'COMMON', 7,  1000);   -- team highlight
INSERT INTO public.topshot_atlas_edition_map VALUES
  ('E1', '00000000-0000-4000-8000-000000000001', '99:3372'),
  ('E2', '00000000-0000-4000-8000-000000000002', '99:3372::17'),
  ('E3', '00000000-0000-4000-8000-000000000003', '5:11');
INSERT INTO public.topshot_atlas_market_events VALUES
  -- open, verified, Standard
  ('u1', 'nba', 'listing', false, 'N1', 'E1', 99, 3372, 4521, 1250, '0xseller1', 'COMMON', now() - interval '3 hours', now() - interval '1 hour'),
  -- open, verified, the parallel printing
  ('u2', 'nba', 'listing', false, 'N2', 'E2', 99, 3372, 12,   99900, '0xseller2', 'RARE', now() - interval '2 days', now() - interval '2 hours'),
  -- relisted Moment: N3 has a superseded open listing (u3old) and a newer one (u3new)
  ('u3old', 'nba', 'listing', false, 'N3', 'E1', 99, 3372, 777, 5000, '0xseller3', 'COMMON', now() - interval '5 days', now() - interval '1 hour'),
  ('u3new', 'nba', 'listing', false, 'N3', 'E1', 99, 3372, 777, 4000, '0xseller3', 'COMMON', now() - interval '1 day',  now() - interval '1 hour'),
  -- open but NOT verified in 24 h → withheld
  ('u4', 'nba', 'listing', false, 'N4', 'E1', 99, 3372, 88, 700, '0xseller4', 'COMMON', now() - interval '10 days', now() - interval '30 hours'),
  -- completed (sold) → never
  ('u5', 'nba', 'listing', true,  'N5', 'E1', 99, 3372, 89, 700, '0xseller5', 'COMMON', now() - interval '1 hour', now() - interval '1 hour'),
  -- an offer, not a listing → never
  ('u6', 'nba', 'offer',   false, 'N6', 'E1', 99, 3372, 90, 700, '0xbuyer6',  'COMMON', now() - interval '1 hour', now() - interval '1 hour'),
  -- nfl → never (this table is Top Shot only)
  ('u7', 'nfl', 'listing', false, 'N7', 'E1', 99, 3372, 91, 700, '0xseller7', 'COMMON', now() - interval '1 hour', now() - interval '1 hour'),
  -- open, verified, but its edition is UNMAPPED → withheld and counted
  ('u8', 'nba', 'listing', false, 'N8', 'E-unmapped', 1, 1, 1, 700, '0xseller8', 'COMMON', now() - interval '1 hour', now() - interval '1 hour'),
  -- team highlight (edition has no player_name)
  ('u9', 'nba', 'listing', false, 'N9', 'E3', 5, 11, 3, 250, '0xseller9', 'COMMON', now() - interval '1 hour', now() - interval '1 hour');
-- a stale row from the dead writer must be gone after the sync
INSERT INTO public.ts_listings (listing_id, flow_id, price_usd, ingested_at) VALUES ('stale-may', 'OLD', 1, '2026-05-15');

-- ── assertions ────────────────────────────────────────────────────────────────
SELECT _assert_eq((SELECT (public.sync_ts_listings_from_atlas())->>'rows'), '4', 'four rows land: u1, u2, u3new, u9');
SELECT _assert_eq((SELECT string_agg(listing_id, ',' ORDER BY listing_id) FROM public.ts_listings), 'u1,u2,u3new,u9',
  'open + verified + mapped only; newest per Moment; the May row is gone');
SELECT _assert_eq((SELECT parallel_id::text FROM public.ts_listings WHERE listing_id = 'u2'), '17', 'parallel id parsed from ::17');
SELECT _assert_eq((SELECT parallel_id::text FROM public.ts_listings WHERE listing_id = 'u1'), '0', 'Standard keys parallel 0');
SELECT _assert_eq((SELECT round(price_usd, 2)::text FROM public.ts_listings WHERE listing_id = 'u1'), '12.50', 'price_cents 1250 → 12.50 USD');
SELECT _assert_eq((SELECT set_id || ':' || play_id || '/' || serial_number || '/' || circulation_count || '/' || moment_tier || '/' || series_number FROM public.ts_listings WHERE listing_id = 'u2'),
  '99:3372/12/250/RARE/7', 'identity, serial, circulation, tier and series carried from the event + edition');
SELECT _assert_eq((SELECT player_name FROM public.ts_listings WHERE listing_id = 'u9'), 'Kings', 'a team highlight names the team, never NULL');
SELECT _assert_eq((SELECT round(price_usd, 2)::text FROM public.ts_listings WHERE flow_id = 'N3'), '40.00', 'the NEWEST listing of a relisted Moment wins');
-- the payload counts what it withheld
SELECT _assert_eq((SELECT j->>'unverified_24h' || '/' || (j->>'unmapped') FROM (SELECT public.sync_ts_listings_from_atlas() j) s), '1/1',
  'one listing withheld as unverified, one as unmapped — counted, not guessed');
-- idempotent: a second sync yields the same set
SELECT _assert_eq((SELECT count(*)::text FROM public.ts_listings), '4', 'a second sync leaves exactly the same four rows');
-- differential (2026-09-07): a sync over an unchanged set touches nothing — no delete/re-insert of the open book
SELECT _assert_eq((SELECT j->>'inserted' || '/' || (j->>'updated') || '/' || (j->>'deleted') FROM (SELECT public.sync_ts_listings_from_atlas() j) s), '0/0/0',
  'an unchanged open set is 0 inserted / 0 updated / 0 deleted');
-- …and a price change on an open listing is an UPDATE of that one row, not a rebuild
UPDATE public.topshot_atlas_market_events SET price_cents = 1300 WHERE uuid = 'u1';
SELECT _assert_eq((SELECT j->>'inserted' || '/' || (j->>'updated') || '/' || (j->>'deleted') || '/' || (j->>'rows') FROM (SELECT public.sync_ts_listings_from_atlas() j) s), '0/1/0/4',
  'one changed price = one updated row, the set still four');
SELECT _assert_eq((SELECT round(price_usd, 2)::text FROM public.ts_listings WHERE listing_id = 'u1'), '13.00', 'the updated price is what the reader sees');
-- sampled diagnostics (2026-09-19, R101 v2): an unsampled tick publishes the two counts as NULL and says so —
-- never 0, which would read as "nothing unmapped, nothing unverified" for a reading that was not taken.
SELECT _assert_eq((SELECT coalesce(j->>'unverified_24h', 'null') || '/' || coalesce(j->>'unmapped', 'null') || '/' || (j->>'diag_sampled')
                     FROM (SELECT public.sync_ts_listings_from_atlas(false) j) s), 'null/null/false',
  'p_diag = false: both diagnostic counts NULL, diag_sampled false');
-- …and the unsampled call still syncs the set identically (the same four rows, nothing rewritten)
SELECT _assert_eq((SELECT j->>'inserted' || '/' || (j->>'updated') || '/' || (j->>'deleted') || '/' || (j->>'rows') FROM (SELECT public.sync_ts_listings_from_atlas(false) j) s), '0/0/0/4',
  'the unsampled tick is a full sync of the set, only the diagnostics are skipped');

ROLLBACK;
