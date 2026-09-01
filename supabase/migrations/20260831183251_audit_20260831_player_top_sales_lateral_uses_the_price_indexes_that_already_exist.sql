-- audit_20260831 — get_player_top_sales: read the top 10 through the
-- (edition_id, price_usd DESC) indexes that ALREADY EXIST on all seven sales
-- partitions, instead of reading every sale for every one of the player's
-- editions and top-N sorting the pile.
--
-- THE DEFECT, reproduced 2026-08-31 18:2xZ on /nba_top_shot/player/lebron-james:
--   COLD  8,178 ms / 34,952 buffers  -> the function's own `statement_timeout=8s`
--         kills it. Vercel runtime errors, 24 h to 18:20Z: 14 occurrences of
--         "[entity-section] player top sales get_player_top_sales failed after
--         retries: canceling statement due to statement timeout — degraded" on
--         /[collection]/player/[slug], most recent 2026-08-31T17:37:01Z.
--   WARM    277 ms / 34,912 buffers  -> same buffers, 29x the wall clock. This is
--         an IO-RESIDENCY problem, not a statistics problem: every sales partition
--         was ANALYZEd 2026-08-31 04:52Z (2026 at 10:53Z) and n_live_tup is sane,
--         so the 08-31 04:55Z vacuum/analyze fix does not apply here.
--
-- ROOT CAUSE — a ready-made index set, ~253 MB across seven partitions, sitting
-- unused because of a NULLS LAST clause. Every partition carries
-- `sales_<year>_edition_id_price_usd_idx (edition_id, price_usd DESC)`. A btree
-- DESC column orders NULLS FIRST, so `ORDER BY price_usd DESC NULLS LAST` cannot
-- be answered from it and the planner fell back to reading ALL of the player's
-- sales (34,154 rows over 126 editions for LeBron) and top-N heapsorting them.
-- ⚠ These indexes do NOT appear in `pg_indexes WHERE tablename='sales'` — they are
-- per-partition, not attached to the ONLY-parent. Look at the partitions.
--
-- THE FIX: a LATERAL top-N per edition ordered `price_usd DESC, sold_at DESC`,
-- then the same outer sort. The planner now runs a Merge Append of seven ordered
-- Index Scans plus an Incremental Sort with `Presorted Key: price_usd` — zero
-- full sorts under the LATERAL.
--
-- A/B, WARM vs WARM, same state, same instrument (total buffers touched):
--   incumbent  34,912 buffers /  277 ms
--   candidate   5,462 buffers /  ~210-939 ms      = 6.4x fewer buffers
--   cold candidate 1,628 ms vs cold incumbent 8,178 ms (which times out)
--
-- ⭐ EQUIVALENCE — AND THE FALSIFIER THAT FIRED. The first candidate ordered the
-- LATERAL by `price_usd DESC` alone; over 25 players that produced 1 MISMATCH
-- (Ben Gordon, 3 ids each way) because an edition whose sales TIE at the cut
-- price had an arbitrary 10 truncated before the outer `sold_at DESC` could
-- choose. Moving the tiebreak INSIDE the LATERAL fixes it and costs nothing
-- (5,208 -> 5,462 buffers). Re-run over 79 NBA Top Shot players in two disjoint
-- slices (25 + 54): 0 mismatches, exact array equality on the returned sale ids.
-- `NULLS LAST` is provably vacuous here: `sales.price_usd` is `is_nullable = NO`
-- and 0 of 4,853,856 rows are NULL, so no `IS NOT NULL` filter is needed.
--
-- ⚠ The signature keeps `p_limit integer DEFAULT 10`. Dropping the default fails
-- with 42P13 "cannot remove parameter defaults from existing function" — a
-- CREATE OR REPLACE must restate every default the live function carries.
--
-- ⛔ The Pinnacle branch is UNTOUCHED — pinnacle_sales is a separate table with no
-- equivalent index and only 9 occurrences of any Pinnacle player timeout.
--
-- EXIT CONDITION — the next pass checks Vercel runtime errors for the group
-- "[entity-section] player top sales get_player_top_sales failed after retries"
-- on /[collection]/player/[slug], over a 24 h window that does NOT straddle this
-- migration (i.e. from 2026-09-01 18:30Z onward):
--     PASS       if 0 occurrences
--     FALSIFIED  if >= 8 occurrences (baseline was 14 in 24 h)
-- FALSIFIED means the parameterized plan is not choosing the Merge Append path,
-- in which case revert the body (below) rather than raising the 8 s timeout.
--
-- REVERT: `CREATE OR REPLACE FUNCTION public.get_player_top_sales(uuid,text,integer)`
-- with the ELSE branch's `top_sales` CTE restored to
--   `FROM sales sa JOIN player_editions pe ON pe.id = sa.edition_id
--    ORDER BY sa.price_usd DESC NULLS LAST, sa.sold_at DESC LIMIT v_safe_limit`.
-- No DDL was performed on any table or index, so there is nothing else to undo.
--
-- anon-exec: unchanged (get_player_top_sales) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege('anon',oid,'EXECUTE') = false and ('authenticated') = false before and after.

CREATE OR REPLACE FUNCTION public.get_player_top_sales(
  p_collection_id uuid,
  p_player_slug   text,
  p_limit         integer DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '8s'
AS $fn$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_player        RECORD;
  result          jsonb;
BEGIN
  SELECT p.* INTO v_player
  FROM players p
  WHERE p.collection_id = p_collection_id
    AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
  LIMIT 1;

  IF v_player IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- Pinnacle path: pinnacle_sales joined to pinnacle_editions on text edition_id
    WITH player_editions AS (
      SELECT id, character_name, set_name, variant_type, thumbnail_url
      FROM pinnacle_editions
      WHERE character_name = v_player.name
    ),
    top_sales AS (
      SELECT
        ps.id::text                AS sale_id,
        pe.id                      AS edition_id,
        pe.id                      AS route_slug,
        pe.character_name          AS player_name,
        pe.set_name,
        pe.variant_type            AS tier,
        pe.thumbnail_url,
        ps.serial_number,
        ps.sale_price_usd          AS price_usd,
        NULL::text                 AS marketplace,
        ps.source                  AS source,
        ps.buyer_address::text     AS buyer_address,
        ps.seller_address::text    AS seller_address,
        ps.nft_id::text            AS nft_id,
        NULL::text                 AS transaction_hash,
        ps.sold_at
      FROM pinnacle_sales ps
      JOIN player_editions pe ON pe.id = ps.edition_id
      ORDER BY ps.sale_price_usd DESC NULLS LAST, ps.sold_at DESC
      LIMIT v_safe_limit
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(top_sales.*)), '[]'::jsonb) INTO result FROM top_sales;
  ELSE
    -- Standard path. 2026-08-31: the per-edition LATERAL is LOAD-BEARING — it is
    -- what lets `sales_<year>_edition_id_price_usd_idx` supply the ordering as a
    -- Merge Append of ordered index scans. The `sold_at DESC` tiebreak INSIDE the
    -- LATERAL is equally load-bearing: without it, an edition whose sales tie at
    -- the cut price truncates arbitrarily and the result set changes.
    WITH player_editions AS (
      SELECT id, name, external_id, set_name, tier::text AS tier, thumbnail_url
      FROM editions
      WHERE collection_id = p_collection_id
        AND (player_id = v_player.id OR player_name = v_player.name)
    ),
    top_sales AS (
      SELECT
        sa.id::text                          AS sale_id,
        sa.edition_id::text                  AS edition_id,
        COALESCE(pe.external_id, pe.id::text) AS route_slug,
        v_player.name                        AS player_name,
        pe.name                              AS edition_name,
        pe.set_name,
        pe.tier,
        pe.thumbnail_url,
        sa.serial_number,
        sa.price_usd,
        sa.marketplace::text                 AS marketplace,
        sa.source                            AS source,
        sa.buyer_address::text               AS buyer_address,
        sa.seller_address::text              AS seller_address,
        sa.nft_id::text                      AS nft_id,
        sa.transaction_hash::text            AS transaction_hash,
        sa.sold_at
      FROM player_editions pe
      JOIN LATERAL (
        SELECT s.id, s.edition_id, s.serial_number, s.price_usd, s.marketplace,
               s.source, s.buyer_address, s.seller_address, s.nft_id,
               s.transaction_hash, s.sold_at
        FROM sales s
        WHERE s.edition_id = pe.id
        ORDER BY s.price_usd DESC, s.sold_at DESC
        LIMIT v_safe_limit
      ) sa ON true
      ORDER BY sa.price_usd DESC NULLS LAST, sa.sold_at DESC
      LIMIT v_safe_limit
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(top_sales.*)), '[]'::jsonb) INTO result FROM top_sales;
  END IF;

  RETURN result;
END;
$fn$;