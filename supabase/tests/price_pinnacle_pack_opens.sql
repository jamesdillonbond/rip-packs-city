-- DB invariant: public.price_pinnacle_pack_opens — writes pinnacle_pack_opens.pull_value_usd, the
-- "what this pack yielded" value on every wallet's Disney Pinnacle pack history.
--
-- Pins:
--   * a pull is named by its mint event; where there is none (every open before the 2025-12-29
--     spork), by what every other record of that nft_id names — the Pinnacle wallet_moments_cache
--     row (never another collection's: a moment_id is unique only WITHIN a collection), a recorded
--     pinnacle_sales row, a pinnacle_live_listings row — and only when they ALL name one render;
--   * the mint event wins over the cache when both exist;
--   * a pack is priced only when EVERY pull is named and priced — never a partial sum;
--   * candidates go least-recently-tried first, so an old never-tried open is not starved by
--     newer opens that are re-eligible every 6 h (the pre-2026-09-29 order was opened_at DESC).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260930004000_audit_20260929_pinnacle_pack_opens_priced_via_sales_and_listings.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.pinnacle_pack_opens (
  pack_nft_id text PRIMARY KEY, moments_pulled int, nft_ids text[], opened_at timestamptz,
  pull_value_usd numeric, priced_at timestamptz);
CREATE TABLE public.pinnacle_mint_events (nft_id text PRIMARY KEY, render_id text);
CREATE TABLE public.pinnacle_catalog (render_id text PRIMARY KEY, fmv_usd numeric);
CREATE TABLE public.wallet_moments_cache (
  wallet_address text, collection_id uuid, moment_id text, render_id text);
CREATE TABLE public.pinnacle_sales (nft_id text, render_id text);
CREATE TABLE public.pinnacle_live_listings (nft_id text PRIMARY KEY, render_id text);

-- >>> BEGIN verbatim price_pinnacle_pack_opens (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.price_pinnacle_pack_opens(p_limit integer DEFAULT 3000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_cand int := 0; v_priced int := 0; v_left int := 0;
BEGIN
  DROP TABLE IF EXISTS _pppo;
  CREATE TEMP TABLE _pppo ON COMMIT DROP AS
  SELECT o.pack_nft_id, o.moments_pulled, o.nft_ids
    FROM public.pinnacle_pack_opens o
   WHERE o.pull_value_usd IS NULL AND o.moments_pulled > 0
     AND (o.priced_at IS NULL OR o.priced_at < now() - interval '6 hours')
   -- least-recently-tried first: an order on a column this job writes, so no row is starved
   ORDER BY o.priced_at NULLS FIRST, o.opened_at DESC NULLS LAST
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 3000), 1), 10000);
  GET DIAGNOSTICS v_cand = ROW_COUNT;

  WITH pulls AS (
    SELECT c.pack_nft_id, c.moments_pulled, u.nft_id
      FROM _pppo c CROSS JOIN LATERAL unnest(c.nft_ids) AS u(nft_id)
  ), named AS (
    -- the pin: its mint event, else (pre-spork opens) what every other record of that nft_id names —
    -- a wallet walk, a recorded sale, a live listing — only when they all name ONE render
    SELECT p.pack_nft_id, p.moments_pulled, COALESCE(m.render_id, w.render_id) AS render_id
      FROM pulls p
      LEFT JOIN public.pinnacle_mint_events m ON m.nft_id = p.nft_id
      LEFT JOIN LATERAL (
        SELECT min(x.render_id) AS render_id
          FROM (
            SELECT wm.render_id FROM public.wallet_moments_cache wm
             WHERE wm.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
               AND wm.moment_id = p.nft_id AND wm.render_id IS NOT NULL
            UNION ALL
            SELECT s.render_id FROM public.pinnacle_sales s
             WHERE s.nft_id = p.nft_id AND s.render_id IS NOT NULL
            UNION ALL
            SELECT l.render_id FROM public.pinnacle_live_listings l
             WHERE l.nft_id = p.nft_id AND l.render_id IS NOT NULL
          ) x
         WHERE m.render_id IS NULL
        HAVING count(DISTINCT x.render_id) = 1
      ) w ON true
  ), pv AS (
    SELECT n.pack_nft_id, SUM(pc.fmv_usd)::numeric(14,2) AS v
      FROM named n
      LEFT JOIN public.pinnacle_catalog pc ON pc.render_id = n.render_id
     GROUP BY n.pack_nft_id, n.moments_pulled
    HAVING count(*) = count(pc.fmv_usd) AND count(*) = n.moments_pulled
  ), upd AS (
    UPDATE public.pinnacle_pack_opens o SET pull_value_usd = pv.v, priced_at = now()
      FROM pv WHERE o.pack_nft_id = pv.pack_nft_id AND o.pull_value_usd IS NULL AND pv.v > 0
    RETURNING 1
  )
  SELECT count(*) INTO v_priced FROM upd;

  UPDATE public.pinnacle_pack_opens o SET priced_at = now()
    FROM _pppo c WHERE o.pack_nft_id = c.pack_nft_id AND o.pull_value_usd IS NULL;

  SELECT count(*) INTO v_left FROM public.pinnacle_pack_opens WHERE pull_value_usd IS NULL;
  RETURN jsonb_build_object('candidates', v_cand, 'priced', v_priced, 'still_null', v_left);
END
$fn$;
-- <<< END verbatim price_pinnacle_pack_opens <<<

INSERT INTO public.pinnacle_catalog VALUES ('R_A', 10), ('R_B', 5), ('R_C', 7), ('R_X', 1000), ('R_NOFMV', NULL);

-- POST: post-spork pull named by its mint event.
-- PRE:  pre-spork pull, no mint event; the Pinnacle cache row names it.
-- WIN:  mint event (R_A) and cache (R_X) disagree -> the mint event is used.
-- XCOL: the only cache row for the id is ANOTHER collection's -> unnamed -> NULL.
-- SPLIT: two Pinnacle cache rows name different renders -> unnamed -> NULL.
-- PART: two pulls, one named+priced, one with no source at all -> NULL (never 10 alone).
-- NOFMV: named but the render has no FMV -> NULL.
INSERT INTO public.pinnacle_mint_events VALUES ('n_post', 'R_A'), ('n_win', 'R_A');
INSERT INTO public.wallet_moments_cache VALUES
  ('0xw1', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'n_pre',   'R_B'),
  ('0xw1', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'n_win',   'R_X'),
  ('0xw1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n_xcol',  'R_C'),
  ('0xw1', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'n_split', 'R_B'),
  ('0xw2', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'n_split', 'R_C'),
  ('0xw1', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'n_pre2',  'R_C'),
  ('0xw1', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'n_nofmv', 'R_NOFMV'),
  ('0xw1', '7dd9dd11-e8b6-45c4-ac99-71331f959714', 'n_conf',  'R_B');
-- SALE: named only by a recorded sale (sold twice, same pin). LIST: only by a live listing.
-- CONF: the cache says R_B, a sale says R_C -> the sources disagree -> unnamed -> NULL.
INSERT INTO public.pinnacle_sales VALUES ('n_sale', 'R_C'), ('n_sale', 'R_C'), ('n_conf', 'R_C'), ('n_win', 'R_X');
INSERT INTO public.pinnacle_live_listings VALUES ('n_list', 'R_B');
INSERT INTO public.pinnacle_pack_opens (pack_nft_id, moments_pulled, nft_ids, opened_at) VALUES
  ('POST',  1, ARRAY['n_post'],            '2026-03-01'),
  ('PRE',   1, ARRAY['n_pre'],             '2024-03-01'),
  ('WIN',   1, ARRAY['n_win'],             '2026-03-02'),
  ('XCOL',  1, ARRAY['n_xcol'],            '2024-03-02'),
  ('SPLIT', 1, ARRAY['n_split'],           '2024-03-03'),
  ('PART',  2, ARRAY['n_post', 'n_gone'],  '2024-03-04'),
  ('MULTI', 2, ARRAY['n_post', 'n_pre2'],  '2024-03-05'),
  ('NOFMV', 1, ARRAY['n_nofmv'],           '2024-03-06'),
  ('SALE',  1, ARRAY['n_sale'],            '2024-03-07'),
  ('LIST',  1, ARRAY['n_list'],            '2024-03-08'),
  ('CONF',  1, ARRAY['n_conf'],            '2024-03-09');

SELECT public.price_pinnacle_pack_opens(100);

-- ── 1. mint event names a post-spork pull ────────────────────────────────────
SELECT _assert_eq((SELECT pull_value_usd::text FROM pinnacle_pack_opens WHERE pack_nft_id='POST'), '10.00', 'post-spork pull priced via its mint event');
-- ── 2. the Pinnacle cache names a pre-spork pull ─────────────────────────────
SELECT _assert_eq((SELECT pull_value_usd::text FROM pinnacle_pack_opens WHERE pack_nft_id='PRE'), '5.00', 'pre-spork pull priced via the Pinnacle cache row');
SELECT _assert_eq((SELECT pull_value_usd::text FROM pinnacle_pack_opens WHERE pack_nft_id='MULTI'), '17.00', 'a pack mixing both sources sums every pull (10 + 7)');
-- ── 3. mint event wins over a disagreeing cache row ──────────────────────────
SELECT _assert_eq((SELECT pull_value_usd::text FROM pinnacle_pack_opens WHERE pack_nft_id='WIN'), '10.00', 'mint event R_A wins, never the cache''s R_X ($1000)');
-- ── 4. never another collection's row, never an ambiguous one ────────────────
SELECT _assert((SELECT pull_value_usd IS NULL FROM pinnacle_pack_opens WHERE pack_nft_id='XCOL'), 'a Top Shot cache row with the same id does not name a Pinnacle pull');
SELECT _assert((SELECT pull_value_usd IS NULL FROM pinnacle_pack_opens WHERE pack_nft_id='SPLIT'), 'cache rows naming two renders do not name the pull');
SELECT _assert_eq((SELECT pull_value_usd::text FROM pinnacle_pack_opens WHERE pack_nft_id='SALE'), '7.00', 'a pull named only by its recorded sales is priced');
SELECT _assert_eq((SELECT pull_value_usd::text FROM pinnacle_pack_opens WHERE pack_nft_id='LIST'), '5.00', 'a pull named only by a live listing is priced');
SELECT _assert((SELECT pull_value_usd IS NULL FROM pinnacle_pack_opens WHERE pack_nft_id='CONF'), 'a cache row and a sale naming different renders leave the pull unnamed');
-- ── 5. never a partial sum ───────────────────────────────────────────────────
SELECT _assert((SELECT pull_value_usd IS NULL FROM pinnacle_pack_opens WHERE pack_nft_id='PART'), 'one unnamed pull leaves the whole pack NULL, not $10');
SELECT _assert((SELECT pull_value_usd IS NULL FROM pinnacle_pack_opens WHERE pack_nft_id='NOFMV'), 'a named pull with no FMV leaves the pack NULL');
-- ── 6. every candidate was tried (stamped), priced or not ────────────────────
SELECT _assert((SELECT bool_and(priced_at IS NOT NULL) FROM pinnacle_pack_opens), 'every candidate stamped priced_at');

-- ── 7. least-recently-tried first ────────────────────────────────────────────
-- NEWTRIED: newest open, last tried 7 h ago (eligible again). OLDNEVER: oldest open, never tried.
-- The old order (opened_at DESC) took NEWTRIED with a limit of 1; OLDNEVER must go first.
INSERT INTO public.pinnacle_pack_opens (pack_nft_id, moments_pulled, nft_ids, opened_at, priced_at) VALUES
  ('NEWTRIED', 1, ARRAY['n_gone'], '2026-09-01', now() - interval '7 hours'),
  ('OLDNEVER', 1, ARRAY['n_gone'], '2023-12-01', NULL);
UPDATE public.pinnacle_pack_opens SET priced_at = now() - interval '1 hour'
 WHERE pack_nft_id NOT IN ('NEWTRIED', 'OLDNEVER');
SELECT public.price_pinnacle_pack_opens(1);
SELECT _assert((SELECT priced_at > now() - interval '1 minute' FROM pinnacle_pack_opens WHERE pack_nft_id='OLDNEVER'), 'the never-tried old open is taken first');
SELECT _assert((SELECT priced_at < now() - interval '6 hours' FROM pinnacle_pack_opens WHERE pack_nft_id='NEWTRIED'), 'the recently-tried newer open waits its turn');

SELECT '✓ price_pinnacle_pack_opens: all assertions passed' AS result;

ROLLBACK;
