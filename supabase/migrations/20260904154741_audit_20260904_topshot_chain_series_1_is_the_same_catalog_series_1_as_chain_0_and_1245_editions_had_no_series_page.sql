-- Found by walking the entity pages in a plain headless browser after the circulation work.
--
-- ⚠ TOP SHOT'S CHAIN SERIES NUMBER IS NOT ITS CATALOG SERIES NUMBER. `collection_series` maps them
-- with an offset — chain 0 → "Series 1", chain 2 → "Series 2", chain 3 → "Summer 2021", chain 4 →
-- "Series 3" … chain 8 → "Series 7" — and there is **no row at all for chain series 1**. Every
-- series RPC filters `e.series = cs.series_number`, so:
--     /nba-top-shot/series/series-1  showed **65** editions (chain 0)
--     chain series 1                 **1,245** editions, **78,344 holder rows** — on NO series page
-- That is **95 % of Top Shot Series 1 missing from its own page**, and from the series index, and
-- from the crawlable series surface.
--
-- ⭐ THE COLLAPSE IS ALREADY THE PRODUCT'S OWN SEMANTICS — this migration does not invent it:
--   1. `get_wallet_moments_with_fmv` already ships `CASE WHEN <top shot> AND e.series = 1 THEN 0
--      ELSE e.series END`, so a collector's OWN collection tab files chain-1 Moments under Series 1.
--      They then click through to a Series 1 page that does not contain them. The two surfaces
--      disagree today, and the wallet one is right.
--   2. The sets prove it. All SIX of chain 0's sets (Base Set, Denied!, Early Adopters, From the
--      Top, Hometown Showdown: Cali vs. NY, Metallic Gold LE) reappear in chain 1, which adds the
--      rest of the canonical 2019-21 Series 1 catalog — Cosmic, Holo MMXX, 2020 NBA Finals, Rookie
--      Debut, Run It Back, MVP Moves, Throwdowns, The Finals. One series, split by a chain quirk.
--
-- THE FIX IS ONE FUNCTION, NOT SIX PREDICATES. "Which chain series numbers belong to this catalog
-- series" was spelled `e.series = cs.series_number` in six places across four functions, so a
-- mapping added to one of them would have desynced the rollup from the page that reads it.
-- `series_chain_numbers()` is now the single place that answers it, and every site calls it.
--
-- ⛔ NOTE FOR WHOEVER ADDS THE NEXT ONE: this is a CATALOG fact, not a formula. Do not try to
-- derive the offset arithmetically — chain 3 is "Summer 2021", which breaks any +1/-1 rule. If a
-- future series needs merging, add it to the CASE with the set-overlap evidence, as above.
-- anon-exec: series_chain_numbers is a pure IMMUTABLE lookup over its two arguments, reads no
--   table, and is called from SECDEF readers that anon already reaches — EXECUTE TO PUBLIC is
--   correct and matches the other slug/label helpers. It cannot leak or write anything.
-- REVERT: restore `e.series = v_series.series_number` / `e.series = cs.series_number` at the six
--   sites (they are the only callers) and DROP FUNCTION public.series_chain_numbers(uuid, integer).

CREATE OR REPLACE FUNCTION public.series_chain_numbers(p_collection_id uuid, p_series_number integer)
RETURNS integer[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    -- Top Shot: chain 0 and chain 1 are both catalog "Series 1" (2019-21). Evidenced by the set
    -- overlap and by get_wallet_moments_with_fmv's own 1 -> 0 display mapping.
    WHEN p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND p_series_number = 0
      THEN ARRAY[0, 1]
    ELSE ARRAY[p_series_number]
  END
$function$;

COMMENT ON FUNCTION public.series_chain_numbers(uuid, integer) IS
  'The chain series numbers belonging to one collection_series row. Top Shot chain 0 and 1 are both catalog Series 1; every other series is itself. Single source of truth for the series RPCs and the rollup refresher.';

DO $splice$
DECLARE
  v_src  text;
  v_new  text;
  v_hits int;
BEGIN
  -- ── get_series_editions: 2 sites (rollup path + no-rollup path) ───────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_series_editions';
  SELECT count(*) INTO v_hits FROM regexp_matches(v_src, 'e\.series = v_series\.series_number', 'g');
  IF v_hits <> 2 THEN
    RAISE EXCEPTION 'get_series_editions: expected 2 series predicates, found %', v_hits;
  END IF;
  v_new := replace(v_src, 'e.series = v_series.series_number',
                          'e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))');
  EXECUTE v_new;

  -- ── get_series_detail: 1 site (the non-rollup fallback count) ─────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_series_detail';
  SELECT count(*) INTO v_hits FROM regexp_matches(v_src, 'e\.series = v_series\.series_number', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'get_series_detail: expected 1 series predicate, found %', v_hits;
  END IF;
  v_new := replace(v_src, 'e.series = v_series.series_number',
                          'e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))');
  EXECUTE v_new;

  -- ── get_series_rollups: 2 sites ──────────────────────────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_series_rollups';
  SELECT count(*) INTO v_hits FROM regexp_matches(v_src, 'e\.series = v_series\.series_number', 'g');
  IF v_hits <> 2 THEN
    RAISE EXCEPTION 'get_series_rollups: expected 2 series predicates, found %', v_hits;
  END IF;
  v_new := replace(v_src, 'e.series = v_series.series_number',
                          'e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))');
  EXECUTE v_new;

  -- ── refresh_series_detail_rollup: 1 site, spelled against cs.* not v_series.* ─────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'refresh_series_detail_rollup';
  SELECT count(*) INTO v_hits FROM regexp_matches(v_src, 'e\.series = cs\.series_number', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'refresh_series_detail_rollup: expected 1 series predicate, found %', v_hits;
  END IF;
  v_new := replace(v_src, 'e.series = cs.series_number',
                          'e.series = ANY (public.series_chain_numbers(cs.collection_id, cs.series_number))');
  EXECUTE v_new;
END
$splice$;
