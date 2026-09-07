-- DB invariant: public.sync_edition_offers_from_atlas — Top Shot's per-edition lowest ask,
-- refreshed from the Atlas marketplace firehose after the GQL offers-sweep host died (2026-09-07).
-- edition_offers.low_ask is the "lowest ask" on the collection grid, moment and edition pages and
-- fmv-recalc's ask feed; a regression here either publishes a stale/higher floor as current or
-- NULLs an edition Atlas simply has not seen.
--
-- Pins:
--   * the floor is the MIN open, verified (24 h) listing price per canonical external_id, with
--     that listing's serial + nft id beside it;
--   * a parallel's listings land on the `::sub` row, never the base row;
--   * an edition with NO open listing in our events is left untouched (Atlas is not a census);
--   * completed listings, unverified listings and inert (non-canonical) keys never contribute;
--   * highest_offer is never written; a re-run over unchanged data writes 0 rows (WHERE guard).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260907022120_audit_20260907_edition_offers_low_ask_from_atlas_the_gql_offers_sweep_is_dead.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.topshot_atlas_market_events (
  uuid text PRIMARY KEY, product text, kind text, completed boolean, nft_id text, atlas_edition_id text,
  serial_number integer, price_cents bigint, last_seen_at timestamptz);
CREATE TABLE public.topshot_atlas_edition_map (atlas_edition_id text PRIMARY KEY, external_id text);
CREATE TABLE public.edition_offers (
  collection_id uuid, external_id text, highest_offer numeric, low_ask numeric, updated_at timestamptz,
  low_ask_serial integer, low_ask_nft_id text, PRIMARY KEY (collection_id, external_id));

-- >>> BEGIN verbatim sync_edition_offers_from_atlas (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.sync_edition_offers_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int;
BEGIN
  WITH floor AS (
    SELECT DISTINCT ON (m.external_id)
           m.external_id, (ev.price_cents::numeric / 100) AS low_ask, ev.serial_number, ev.nft_id
      FROM public.topshot_atlas_market_events ev
      JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
       AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
       AND ev.last_seen_at > now() - interval '24 hours'
       AND m.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
     ORDER BY m.external_id, ev.price_cents ASC, ev.serial_number ASC NULLS LAST
  ), up AS (
    INSERT INTO public.edition_offers (collection_id, external_id, low_ask, low_ask_serial, low_ask_nft_id, updated_at)
    SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd', f.external_id, f.low_ask, f.serial_number, f.nft_id, now()
      FROM floor f
    ON CONFLICT (collection_id, external_id) DO UPDATE
      SET low_ask = EXCLUDED.low_ask,
          low_ask_serial = EXCLUDED.low_ask_serial,
          low_ask_nft_id = EXCLUDED.low_ask_nft_id,
          updated_at = now()
      WHERE public.edition_offers.low_ask IS DISTINCT FROM EXCLUDED.low_ask
         OR public.edition_offers.low_ask_nft_id IS DISTINCT FROM EXCLUDED.low_ask_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM up;
  RETURN jsonb_build_object('rows', v_n, 'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;
-- <<< END verbatim sync_edition_offers_from_atlas <<<

INSERT INTO public.topshot_atlas_edition_map VALUES ('E1', '99:3372'), ('E2', '99:3372::17'), ('E3', 'a1b2c3d4-0000-4000-8000-000000000000:x');
INSERT INTO public.topshot_atlas_market_events VALUES
  ('u1', 'nba', 'listing', false, 'N1', 'E1', 4521, 1250, now() - interval '1 hour'),   -- $12.50
  ('u2', 'nba', 'listing', false, 'N2', 'E1', 12,   900,  now() - interval '2 hours'),  -- $9.00 ← the floor
  ('u3', 'nba', 'listing', false, 'N3', 'E1', 3,    100,  now() - interval '30 hours'), -- $1 but UNVERIFIED
  ('u4', 'nba', 'listing', true,  'N4', 'E1', 4,    50,   now() - interval '1 hour'),   -- $0.50 but SOLD
  ('u5', 'nba', 'listing', false, 'N5', 'E2', 17,   99900, now() - interval '1 hour'),  -- the parallel
  ('u6', 'nba', 'listing', false, 'N6', 'E3', 1,    10,   now() - interval '1 hour');   -- inert key
INSERT INTO public.edition_offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '99:3372', 7.00, 40.00, '2026-08-28', NULL, NULL),  -- stale, higher
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:1',     3.00, 55.00, '2026-08-28', NULL, NULL);  -- Atlas has not seen it

SELECT _assert_eq((SELECT (public.sync_edition_offers_from_atlas())->>'rows'), '2', 'the base row is refreshed and the parallel row inserted');
SELECT _assert_eq((SELECT round(low_ask, 2)::text || '/' || low_ask_serial || '/' || low_ask_nft_id || '/' || round(highest_offer, 2)::text FROM public.edition_offers WHERE external_id = '99:3372'),
  '9.00/12/N2/7.00', 'floor = min OPEN VERIFIED listing, with its serial + nft; highest_offer untouched');
SELECT _assert((SELECT updated_at > now() - interval '1 minute' FROM public.edition_offers WHERE external_id = '99:3372'), 'refreshed row carries a fresh updated_at');
SELECT _assert_eq((SELECT round(low_ask, 2)::text || '/' || low_ask_serial FROM public.edition_offers WHERE external_id = '99:3372::17'), '999.00/17', 'the parallel lands on its ::sub row');
SELECT _assert_eq((SELECT round(low_ask, 2)::text || '/' || updated_at::date FROM public.edition_offers WHERE external_id = '1:1'), '55.00/2026-08-28', 'an edition Atlas has not seen is left exactly as it was — never NULLed');
SELECT _assert((SELECT NOT EXISTS (SELECT 1 FROM public.edition_offers WHERE external_id LIKE 'a1b2c3d4%')), 'an inert uuid-keyed map row never writes a floor');
SELECT _assert_eq((SELECT (public.sync_edition_offers_from_atlas())->>'rows'), '0', 'a second run over unchanged data writes nothing');

ROLLBACK;
