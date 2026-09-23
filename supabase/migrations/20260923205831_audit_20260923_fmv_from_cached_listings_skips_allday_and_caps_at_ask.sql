-- audit_20260923_fmv_from_cached_listings_skips_allday_and_caps_at_ask
--
-- Trevor 2026-09-23: "do what you think is best" on inbox filing
-- 2026-09-23T0510Z-a-fourth-ask-only-writer-republishes-third-party-valuations-over-troll-floors.md.
--
-- WHY. `fmv_from_cached_listings` (called every 20 min by the All Day, Golazos and UFC
-- listing-cache routes) was a FOURTH writer of All Day ASK_ONLY prices, outside the
-- ghost fix (20260922205752) and outside Claude Code's rescuer fix (20260923011039).
-- It reads the Flowty-fed legacy `cached_listings`, which for All Day held mostly
-- $1,000,000 troll asks. It published AVG(Flowty valuation) as ASK_ONLY with that $1M
-- as the floor. At 9:54 PM PT on 2026-09-22 it re-created a price the retirement had
-- removed four hours earlier (Mark Andrews, Dynamic), and it held FMVs far above a live
-- buy-it-now: Jer'Zhan Newton $60.39 vs a $3 live ask; Isaac Bruce $50.14 vs $4;
-- Xavier Worthy $202.76 vs $46.
--
-- WHAT CHANGES (measured before choosing the shape):
--   1. NFL All Day returns 0. Its ASK_ONLY lane already has two ghost-aware writers
--      reading the on-chain listings; the Flowty cache is a staler, troll-heavy subset.
--   2. FMV is capped at the cheapest ask under the $5000 sanity ceiling (the 2026-08-07
--      ask-ceiling rule the fmv-recalc path already applies). Golazos, where this lane
--      is the main price source, barely moves: 0 of its 67 current rows sit above their
--      Flowty min ask, so the cap is a guard, not a repricing.
--   3. An ask above the ceiling is never recorded as floor_price_usd / flowty_ask /
--      cross_market_ask (NULL instead of $1,000,000).
--   4. The DELETE touches only ASK_ONLY rows. It used to delete LOW rows too, so a
--      Flowty valuation could replace a sales-derived LOW price. The NOT EXISTS guard now
--      also protects editions with a LOW (sales-backed) row, not just HIGH/MEDIUM.
--   5. The 10 All Day editions whose current row is `ask_only_v2` are retired to
--      NO_DATA (`allday-ask-retired-v1`, the shape 20260923011039 uses). Job 19's
--      ghost-aware rescuer re-prices any that have a genuine live ask.
--
-- ⚠ Run `SELECT public.refresh_edition_fmv_current(false);` after this migration: the
-- snapshot is not the surface (edition_fmv_current is a cache the boards read).
--
-- REVERT: re-apply the function body from
-- supabase/migrations/20260711185416_audit_20260711_fmv_snapshots_rename_wap_to_asp.sql,
-- then DELETE FROM fmv_snapshots WHERE algo_version = 'allday-ask-retired-v1'
-- AND computed_at >= '<this migration's apply time>', then refresh_edition_fmv_current(false).
--
-- anon-exec: intentional — fmv_from_cached_listings keeps the ACL it already has (anon=false, authenticated=false, service_role=true, verified live before shipping). CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would be a change this migration does not intend.

CREATE OR REPLACE FUNCTION public.fmv_from_cached_listings(p_collection_id uuid, p_algo_version text DEFAULT 'ask_only_v2'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  rows_inserted integer := 0;
  ask_price_ceiling numeric := 5000;
BEGIN
  -- 2026-09-23: NFL All Day is NOT priced here. Its ASK_ONLY lane is owned by
  -- fmv-recalc Step 5d and refresh_allday_ask_fmv_from_listings, both of which read
  -- the on-chain listings (cached_listings_v2) through the ghost filter
  -- (allday_listings_sold_after_listing). The Flowty cache this function reads held
  -- mostly $1,000,000 troll asks for All Day, and publishing Flowty's valuation over
  -- them put FMVs 20x above a live buy-it-now (Jer'Zhan Newton $60.39 vs a $3 ask) and
  -- re-created prices the ghost fix had just retired.
  IF p_collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN
    RETURN 0;
  END IF;

  -- Targeted DELETE: only this lane's own ASK_ONLY rows. It used to delete LOW rows
  -- too, which let a Flowty valuation replace a sales-derived LOW price.
  DELETE FROM fmv_snapshots fs
  WHERE fs.collection_id = p_collection_id
    AND fs.confidence = 'ASK_ONLY'::fmv_confidence
    AND fs.edition_id IN (
      SELECT DISTINCT e.id
      FROM cached_listings cl
      JOIN editions e ON e.collection_id = p_collection_id
        AND (
          (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
          OR
          (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
           AND normalize_name(e.player_name) = normalize_name(cl.player_name)
           AND normalize_name(e.set_name) = normalize_name(cl.set_name))
        )
      WHERE cl.collection_id = p_collection_id
        AND cl.ask_price > 0
        AND NOT EXISTS (
          SELECT 1 FROM fmv_snapshots f2
          WHERE f2.edition_id = e.id
            AND f2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence)
        )
    );

  -- INSERT new ASK_ONLY rows. The valuation is capped at the cheapest ask under the
  -- sanity ceiling (the ask-ceiling rule: a base FMV above buy-it-now is a confident
  -- wrong number), and an ask above the ceiling is never recorded as a floor.
  INSERT INTO fmv_snapshots (
    edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd,
    confidence, listing_count, algo_version, computed_at,
    liquidity_rating, top_shot_ask, flowty_ask, cross_market_ask
  )
  SELECT
    e.id AS edition_id,
    p_collection_id,
    -- Primary: avg of cl.fmv when present; fallback: MIN(ask_price) under the ceiling.
    -- LEAST ignores NULLs, so an ask above the ceiling simply does not cap.
    LEAST(
      COALESCE(
        NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
        CASE
          WHEN MIN(cl.ask_price) <= ask_price_ceiling
          THEN ROUND(MIN(cl.ask_price), 2)
          ELSE NULL  -- no FMV row produced — better silence than $1M garbage
        END
      ),
      CASE
        WHEN MIN(cl.ask_price) <= ask_price_ceiling
        THEN ROUND(MIN(cl.ask_price), 2)
        ELSE NULL
      END
    ) AS fmv_usd,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS floor_price_usd,
    NULL AS wap_usd,
    'ASK_ONLY'::fmv_confidence AS confidence,
    COUNT(cl.id)::int AS listing_count,
    p_algo_version,
    NOW(),
    1 AS liquidity_rating,
    NULL AS top_shot_ask,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS flowty_ask,
    CASE WHEN MIN(cl.ask_price) <= ask_price_ceiling THEN ROUND(MIN(cl.ask_price), 2) ELSE NULL END AS cross_market_ask
  FROM cached_listings cl
  JOIN editions e ON e.collection_id = p_collection_id
    AND (
      (cl.moment_id IS NOT NULL AND e.external_id = cl.moment_id)
      OR
      (e.player_name IS NOT NULL AND cl.player_name IS NOT NULL
       AND normalize_name(e.player_name) = normalize_name(cl.player_name)
       AND normalize_name(e.set_name) = normalize_name(cl.set_name))
    )
  WHERE cl.collection_id = p_collection_id
    AND cl.ask_price > 0
    AND NOT EXISTS (
      SELECT 1 FROM fmv_snapshots fs2
      WHERE fs2.edition_id = e.id
        AND fs2.confidence IN ('HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence)
    )
  GROUP BY e.id
  -- HAVING clause excludes editions where the resulting fmv_usd would be NULL
  HAVING COALESCE(
    NULLIF(ROUND(AVG(cl.fmv) FILTER (WHERE cl.fmv > 0), 2), 0),
    CASE
      WHEN MIN(cl.ask_price) <= ask_price_ceiling
      THEN ROUND(MIN(cl.ask_price), 2)
      ELSE NULL
    END
  ) IS NOT NULL;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;
  RETURN rows_inserted;
END;
$function$;

WITH latest AS (
  SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.algo_version
  FROM fmv_snapshots fs
  WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND fs.computed_at > now() - interval '30 days'
  ORDER BY fs.edition_id, fs.computed_at DESC
), targets AS (
  SELECT l.edition_id FROM latest l WHERE l.algo_version = 'ask_only_v2'
)
INSERT INTO fmv_snapshots (
  edition_id, collection_id, fmv_usd, floor_price_usd,
  asp_usd, ask_proxy_fmv, cross_market_ask,
  confidence, listing_count, algo_version, computed_at, collection,
  sales_count_7d, sales_count_30d
)
SELECT t.edition_id, 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid,
       NULL, NULL, NULL, NULL, NULL,
       'NO_DATA'::fmv_confidence, NULL, 'allday-ask-retired-v1', now(), 'nfl_all_day',
       0, 0
FROM targets t;

DO $assert$
DECLARE v_left int; v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.fmv_from_cached_listings(uuid,text)'::regprocedure;
  IF position('dee28451-5d62-409e-a1ad-a83f763ac070' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fmv_from_cached_listings does not exclude All Day';
  END IF;
  IF position('LEAST(' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fmv_from_cached_listings does not cap at the ask';
  END IF;
  IF has_function_privilege('anon', 'public.fmv_from_cached_listings(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute fmv_from_cached_listings';
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.algo_version
    FROM fmv_snapshots fs
    WHERE fs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
      AND fs.computed_at > now() - interval '30 days'
    ORDER BY fs.edition_id, fs.computed_at DESC
  )
  SELECT count(*) INTO v_left FROM latest WHERE algo_version = 'ask_only_v2';
  IF v_left > 0 THEN
    RAISE EXCEPTION '% All Day editions still publish an ask_only_v2 price', v_left;
  END IF;
END
$assert$;
