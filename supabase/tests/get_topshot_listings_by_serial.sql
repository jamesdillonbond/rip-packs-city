-- DB invariant: get_topshot_listings_by_serial(p_serial, p_max_price_usd, p_tier, p_limit) — feedback #12359.
-- Pinned 2026-11-14. What must hold:
--   1. a row seen within 24 h is confirmed_24h;
--   2. a row on a COMPLETE edition verified within 7 d, re-seen at that read, is confirmed_verified;
--      a row OLDER than the verify on a complete edition is UNCONFIRMED (never counted as confirmed);
--   3. a row on an INCOMPLETE (or stale-verified) edition is unconfirmed;
--   4. a completed row never appears; another serial never appears; one row per nft_id (newest listing);
--   5. coverage counts are over the uncapped set; rows are confirmed first then price ascending;
--   6. price / tier filters apply to rows AND counts.
-- The function DDL is VERBATIM from
-- supabase/migrations/20261114162100_audit_20261114_topshot_listings_by_serial.sql;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift. Runs in a rolled-back transaction.

BEGIN;

CREATE TABLE public.topshot_atlas_market_events (
  uuid text PRIMARY KEY, product text, kind text, nft_id text, listing_resource_id text, price_cents bigint,
  listed_at timestamptz, last_seen_at timestamptz, serial_number int, atlas_edition_id text,
  set_id_onchain int, play_id_onchain int, parallel text, tier text, completed boolean
);
CREATE TABLE public.topshot_atlas_edition_verified (atlas_edition_id text PRIMARY KEY, verified_at timestamptz, complete boolean);
CREATE TABLE public.topshot_atlas_edition_map (atlas_edition_id text PRIMARY KEY, rpc_edition_id uuid, external_id text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id text, player_name text, team_name text, set_name text, tier text, circulation_count int
);
-- fixture stand-in for the per-id FMV helper (same signature / result shape as production)
CREATE FUNCTION public.get_fmv_for_editions(p_collection_id uuid, p_edition_ids uuid[])
RETURNS TABLE(edition_id uuid, fmv_usd numeric) LANGUAGE sql AS $$
  SELECT e.id, 12.5::numeric FROM public.editions e WHERE e.id = ANY (p_edition_ids)
$$;

-- >>> BEGIN verbatim get_topshot_listings_by_serial >>>
CREATE OR REPLACE FUNCTION public.get_topshot_listings_by_serial(
  p_serial int,
  p_max_price_usd numeric DEFAULT NULL,
  p_tier text DEFAULT NULL,
  p_limit int DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_tier text := nullif(upper(btrim(coalesce(p_tier, ''))), '');
  v_max_cents bigint := CASE WHEN p_max_price_usd IS NULL OR p_max_price_usd <= 0 THEN NULL ELSE floor(p_max_price_usd * 100)::bigint END;
  v_out jsonb;
BEGIN
  IF p_serial IS NULL OR p_serial < 1 THEN
    RETURN jsonb_build_object('rows', '[]'::jsonb, 'coverage', NULL);
  END IF;

  WITH ev AS (
    SELECT DISTINCT ON (x.nft_id)
           x.nft_id, x.listing_resource_id, x.price_cents, x.listed_at, x.last_seen_at, x.serial_number,
           x.atlas_edition_id, x.set_id_onchain, x.play_id_onchain, x.parallel, x.tier
      FROM public.topshot_atlas_market_events x
     WHERE x.product = 'nba' AND x.kind = 'listing' AND NOT x.completed AND x.nft_id IS NOT NULL
       AND x.serial_number = p_serial
       AND x.last_seen_at > now() - interval '60 days'
       AND x.price_cents > 0
     ORDER BY x.nft_id, x.listed_at DESC NULLS LAST, x.last_seen_at DESC
  ),
  cls AS (
    SELECT ev.*,
           CASE
             WHEN ev.last_seen_at > now() - interval '24 hours' THEN 'confirmed_24h'
             WHEN v.complete AND v.verified_at > now() - interval '7 days'
                  AND ev.last_seen_at >= v.verified_at - interval '10 minutes' THEN 'confirmed_verified'
             ELSE 'unconfirmed'
           END AS confirmation,
           v.complete AS book_complete,
           v.verified_at AS book_verified_at
      FROM ev
      LEFT JOIN public.topshot_atlas_edition_verified v ON v.atlas_edition_id = ev.atlas_edition_id
  ),
  filt AS (
    SELECT c.*, m.rpc_edition_id, m.external_id AS map_external_id
      FROM cls c
      LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = c.atlas_edition_id
     WHERE (v_max_cents IS NULL OR c.price_cents <= v_max_cents)
       AND (v_tier IS NULL OR upper(c.tier) = v_tier)
  ),
  ranked AS (
    SELECT f.*,
           row_number() OVER (PARTITION BY (f.confirmation = 'unconfirmed') ORDER BY f.price_cents, f.nft_id) AS rn
      FROM filt f
  ),
  picked AS (
    SELECT r.* FROM ranked r WHERE r.rn <= v_limit
  ),
  fmv AS (
    SELECT g.edition_id, g.fmv_usd
      FROM public.get_fmv_for_editions(c_ts, ARRAY(SELECT DISTINCT p.rpc_edition_id FROM picked p WHERE p.rpc_edition_id IS NOT NULL)) g
  ),
  out_rows AS (
    SELECT jsonb_build_object(
             'nft_id', p.nft_id,
             'listing_resource_id', p.listing_resource_id,
             'price_usd', round(p.price_cents::numeric / 100, 2),
             'serial_number', p.serial_number,
             'confirmation', p.confirmation,
             'listed_at', p.listed_at,
             'last_seen_at', p.last_seen_at,
             'book_verified_at', CASE WHEN p.book_complete THEN p.book_verified_at END,
             'edition_id', p.rpc_edition_id,
             'external_id', coalesce(e.external_id::text, p.map_external_id),
             'player_name', coalesce(e.player_name, e.team_name),
             'set_name', e.set_name,
             'tier', coalesce(p.tier, e.tier::text),
             'parallel', p.parallel,
             'circulation_count', e.circulation_count,
             'fmv_usd', f.fmv_usd
           ) AS j,
           (p.confirmation = 'unconfirmed') AS is_unconf,
           p.price_cents, p.nft_id
      FROM picked p
      LEFT JOIN public.editions e ON e.id = p.rpc_edition_id
      LEFT JOIN fmv f ON f.edition_id = p.rpc_edition_id
  )
  SELECT jsonb_build_object(
    'rows', coalesce((SELECT jsonb_agg(o.j ORDER BY o.is_unconf, o.price_cents, o.nft_id) FROM out_rows o), '[]'::jsonb),
    'coverage', jsonb_build_object(
      'serial', p_serial,
      'confirmed_count', (SELECT count(*) FROM filt WHERE confirmation <> 'unconfirmed'),
      'confirmed_24h', (SELECT count(*) FROM filt WHERE confirmation = 'confirmed_24h'),
      'confirmed_verified', (SELECT count(*) FROM filt WHERE confirmation = 'confirmed_verified'),
      'unconfirmed_count', (SELECT count(*) FROM filt WHERE confirmation = 'unconfirmed'),
      'editions_with_listing', (SELECT count(DISTINCT atlas_edition_id) FROM filt),
      'editions_verified_7d', (SELECT count(DISTINCT atlas_edition_id) FROM filt
                                WHERE book_complete AND book_verified_at > now() - interval '7 days'),
      'returned_confirmed', (SELECT count(*) FROM picked WHERE confirmation <> 'unconfirmed'),
      'returned_unconfirmed', (SELECT count(*) FROM picked WHERE confirmation = 'unconfirmed'),
      'window_hours', 24,
      'verify_days', 7,
      'lookback_days', 60
    )
  ) INTO v_out;

  RETURN v_out;
END
$fn$;
-- <<< END verbatim get_topshot_listings_by_serial <<<

-- Editions: A complete + verified 1 day ago; B INCOMPLETE; C complete but verified 10 days ago.
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-00000000000a','1:1','Player A',NULL,'Set A','COMMON',1000),
  ('00000000-0000-0000-0000-00000000000b','2:2',NULL,'Team B','Set B','RARE',99),
  ('00000000-0000-0000-0000-00000000000c','3:3','Player C',NULL,'Set C','COMMON',500);
INSERT INTO public.topshot_atlas_edition_map VALUES
  ('A','00000000-0000-0000-0000-00000000000a','1:1'),
  ('B','00000000-0000-0000-0000-00000000000b','2:2'),
  ('C','00000000-0000-0000-0000-00000000000c','3:3');
INSERT INTO public.topshot_atlas_edition_verified VALUES
  ('A', now() - interval '1 day', true),
  ('B', now() - interval '1 day', false),
  ('C', now() - interval '10 days', true);
INSERT INTO public.topshot_atlas_market_events VALUES
  -- n1: seen 2 h ago → confirmed_24h ($30)
  ('u1','nba','listing','n1','L1',3000, now()-interval '5 days', now()-interval '2 hours', 23,'A',1,1,'Standard','COMMON',false),
  -- n2: on A, re-seen at A's verify (verify - 1 min) → confirmed_verified ($10)
  ('u2','nba','listing','n2','L2',1000, now()-interval '9 days', now()-interval '1 day 1 minute', 23,'A',1,1,'Standard','COMMON',false),
  -- n3: on A but last seen 3 days ago, BEFORE the verify → unconfirmed ($5)
  ('u3','nba','listing','n3','L3', 500, now()-interval '9 days', now()-interval '3 days', 23,'A',1,1,'Standard','COMMON',false),
  -- n4: on INCOMPLETE B, seen 2 days ago → unconfirmed ($7)
  ('u4','nba','listing','n4','L4', 700, now()-interval '9 days', now()-interval '2 days', 23,'B',2,2,'Standard','RARE',false),
  -- n5: on C, verified 10 d ago (stale) → unconfirmed ($8)
  ('u5','nba','listing','n5','L5', 800, now()-interval '20 days', now()-interval '10 days', 23,'C',3,3,'Standard','COMMON',false),
  -- n6: completed → never appears
  ('u6','nba','listing','n6','L6', 100, now()-interval '1 day', now()-interval '1 hour', 23,'A',1,1,'Standard','COMMON',true),
  -- n7: another serial → never appears
  ('u7','nba','listing','n7','L7', 100, now()-interval '1 day', now()-interval '1 hour', 24,'A',1,1,'Standard','COMMON',false),
  -- n8: relisted — the NEWER listing ($40) wins over the older open one ($2)
  ('u8a','nba','listing','n8','L8a', 200, now()-interval '30 days', now()-interval '1 hour', 23,'A',1,1,'Standard','COMMON',false),
  ('u8b','nba','listing','n8','L8b',4000, now()-interval '1 day',   now()-interval '1 hour', 23,'A',1,1,'Standard','COMMON',false),
  -- n9: an offer row, not a listing → never appears
  ('u9','nba','offer','n9',NULL, 100, now()-interval '1 day', now()-interval '1 hour', 23,'A',1,1,'Standard','COMMON',false),
  -- n10: All Day product → never appears
  ('u10','nfl','listing','n10','L10', 100, now()-interval '1 day', now()-interval '1 hour', 23,'A',1,1,'Standard','COMMON',false);

CREATE TEMP TABLE r AS SELECT public.get_topshot_listings_by_serial(23) AS j;
CREATE TEMP TABLE rr AS SELECT x->>'nft_id' AS nft, x->>'confirmation' AS conf, (x->>'price_usd')::numeric AS price, x
  FROM r, jsonb_array_elements(r.j->'rows') x;

SELECT _assert_eq((SELECT conf FROM rr WHERE nft='n1'), 'confirmed_24h', 'seen 2 h ago → confirmed_24h');
SELECT _assert_eq((SELECT conf FROM rr WHERE nft='n2'), 'confirmed_verified', 're-seen at a complete verify ≤ 7 d → confirmed_verified');
SELECT _assert_eq((SELECT conf FROM rr WHERE nft='n3'), 'unconfirmed', 'older than the verify on a complete edition → unconfirmed, never confirmed');
SELECT _assert_eq((SELECT conf FROM rr WHERE nft='n4'), 'unconfirmed', 'incomplete edition → unconfirmed');
SELECT _assert_eq((SELECT conf FROM rr WHERE nft='n5'), 'unconfirmed', 'complete but verified 10 d ago → unconfirmed');
SELECT _assert_eq((SELECT count(*)::text FROM rr WHERE nft IN ('n6','n7','n9','n10')), '0', 'completed / other serial / offer / other product never appear');
SELECT _assert_eq((SELECT count(*)::text FROM rr WHERE nft='n8'), '1', 'one row per nft_id');
SELECT _assert_eq((SELECT price::text FROM rr WHERE nft='n8'), '40.00', 'the NEWEST listing of a relisted Moment wins');

SELECT _assert_eq((SELECT string_agg(nft, ',' ORDER BY ord) FROM (SELECT x->>'nft_id' AS nft, o AS ord FROM r, jsonb_array_elements(r.j->'rows') WITH ORDINALITY AS t(x, o)) s),
  'n2,n1,n8,n3,n4,n5', 'confirmed first (price asc), then unconfirmed (price asc)');

SELECT _assert_eq((SELECT (j->'coverage'->>'confirmed_count') FROM r), '3', 'confirmed = n1 + n2 + n8');
SELECT _assert_eq((SELECT (j->'coverage'->>'confirmed_24h') FROM r), '2', 'confirmed_24h = n1 + n8');
SELECT _assert_eq((SELECT (j->'coverage'->>'confirmed_verified') FROM r), '1', 'confirmed_verified = n2');
SELECT _assert_eq((SELECT (j->'coverage'->>'unconfirmed_count') FROM r), '3', 'unconfirmed = n3 + n4 + n5');
SELECT _assert_eq((SELECT (j->'coverage'->>'editions_with_listing') FROM r), '3', 'three editions carry a #23');
SELECT _assert_eq((SELECT (j->'coverage'->>'editions_verified_7d') FROM r), '1', 'only A has a complete verify ≤ 7 d');

SELECT _assert_eq((SELECT x->>'player_name' FROM rr WHERE nft='n4'), 'Team B', 'team subject when the edition has no player');
SELECT _assert_eq((SELECT x->>'fmv_usd' FROM rr WHERE nft='n1'), '12.5', 'FMV through the per-id helper');
SELECT _assert_eq((SELECT x->>'circulation_count' FROM rr WHERE nft='n1'), '1000', 'circulation from editions');
SELECT _assert((SELECT x->'book_verified_at' = 'null'::jsonb FROM rr WHERE nft='n4'), 'an INCOMPLETE book carries no verified_at');

-- cap applies per class; coverage stays uncapped
SELECT _assert_eq((SELECT jsonb_array_length(public.get_topshot_listings_by_serial(23, NULL, NULL, 1)->'rows')::text), '2', 'p_limit=1 → one confirmed + one unconfirmed');
SELECT _assert_eq((SELECT public.get_topshot_listings_by_serial(23, NULL, NULL, 1)->'coverage'->>'confirmed_count'), '3', 'coverage is uncapped');

-- filters
SELECT _assert_eq((SELECT public.get_topshot_listings_by_serial(23, 9.99)->'coverage'->>'confirmed_count'), '0', 'maxPrice $9.99 excludes n2 ($10)');
SELECT _assert_eq((SELECT public.get_topshot_listings_by_serial(23, 10)->'coverage'->>'confirmed_count'), '1', 'maxPrice is inclusive');
SELECT _assert_eq((SELECT public.get_topshot_listings_by_serial(23, NULL, 'rare')->'coverage'->>'unconfirmed_count'), '1', 'tier filter is case-insensitive (n4 only)');
SELECT _assert_eq((SELECT jsonb_array_length(public.get_topshot_listings_by_serial(999)->'rows')::text), '0', 'no listings → empty rows');
SELECT _assert_eq((SELECT public.get_topshot_listings_by_serial(999)->'coverage'->>'confirmed_count'), '0', 'no listings → a measured 0');
SELECT _assert_eq((SELECT jsonb_array_length(public.get_topshot_listings_by_serial(0)->'rows')::text), '0', 'serial 0 → nothing');

\echo '✓ get_topshot_listings_by_serial: 24h / verified / unconfirmed classes, newest listing per Moment, uncapped coverage'

ROLLBACK;
