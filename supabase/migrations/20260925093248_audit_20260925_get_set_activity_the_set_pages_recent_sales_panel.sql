-- 2026-09-25 (PT) — set pages had no sales panel. Player pages carry "Top
-- Sales", team pages "Market Activity", edition pages the full ledger; the set
-- page stopped at the tier mix and the editions grid, so the one entity that
-- groups editions by product showed no market at all. This is the team
-- function's shape keyed on the set instead of the team: the same slug rule
-- sets_summary uses (regexp_replace(lower(set_name), '[^a-z0-9]+', '-')), the
-- same variants fold, the same narrow/wide split.
--
-- COST, measured 2:40 AM PT before this was written: the WIDE path on the
-- largest Top Shot set (Base Set, 3,747 editions) streams the collection's
-- (collection_id, sold_at DESC) index and stops at the 30th hit — 2,225
-- buffers, 10 ms — because Base Set trades constantly. A COLD wide set would
-- walk deeper, so the wide path carries a 365-day floor (a "recent sales"
-- panel is a recent-sales panel; the team function has no floor and is not
-- changed here). The NARROW path is the team gate (editions × window ≤ 2000
-- index probes through idx_sales_edition).
--
-- Honesty: an unknown slug or a set with no editions returns '[]' (the page's
-- three-state helper turns an RPC ERROR into "unavailable", never into "No
-- recent sales"). Revert: DROP FUNCTION public.get_set_activity(uuid, text, integer, integer);

-- anon-exec: intentional — get_set_activity is service_role-only (REVOKEd from PUBLIC, anon, authenticated below), read server-side by the set page exactly like get_team_activity, its sibling.
CREATE OR REPLACE FUNCTION public.get_set_activity(p_collection_id uuid, p_set_slug text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_variants    text[];
  v_safe_limit  int := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_safe_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_edition_ids uuid[];
  v_n_eds       int;
  v_window      int;
  result        jsonb;
BEGIN
  SELECT array_agg(DISTINCT set_name) INTO v_variants
  FROM editions
  WHERE collection_id = p_collection_id
    AND set_name IS NOT NULL
    AND regexp_replace(lower(set_name), '[^a-z0-9]+', '-', 'g') = p_set_slug;
  IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT array_agg(id) INTO v_edition_ids
  FROM editions
  WHERE collection_id = p_collection_id
    AND set_name = ANY(v_variants);
  IF v_edition_ids IS NULL THEN RETURN '[]'::jsonb; END IF;

  v_n_eds  := COALESCE(array_length(v_edition_ids, 1), 0);
  v_window := v_safe_limit + v_safe_offset;

  IF v_n_eds > 0 AND (v_n_eds::bigint * v_window::bigint) <= 2000 THEN
    -- NARROW SET: each edition's own most-recent window via idx_sales_edition, merged.
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result FROM (
      SELECT
        COALESCE(e.external_id, e.id::text) AS route_slug,
        e.player_name,
        e.set_name,
        e.team_name,
        e.play_type,
        e.tier::text                        AS tier,
        e.thumbnail_url,
        ts.serial_number,
        ts.price_usd,
        ts.sold_at,
        ts.marketplace
      FROM (
        SELECT cand.edition_id, cand.serial_number, cand.price_usd, cand.sold_at, cand.marketplace
        FROM unnest(v_edition_ids) AS ed(id)
        CROSS JOIN LATERAL (
          SELECT s.edition_id, s.serial_number, s.price_usd, s.sold_at, s.marketplace
          FROM sales s
          WHERE s.collection_id = p_collection_id
            AND s.edition_id = ed.id
          ORDER BY s.sold_at DESC
          LIMIT v_window
        ) cand
        ORDER BY cand.sold_at DESC
        LIMIT v_safe_limit OFFSET v_safe_offset
      ) ts
      JOIN editions e ON e.id = ts.edition_id
      ORDER BY ts.sold_at DESC
    ) t;
  ELSE
    -- WIDE SET: stream the collection's sold_at index, bounded to a year.
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result FROM (
      SELECT
        COALESCE(e.external_id, e.id::text) AS route_slug,
        e.player_name,
        e.set_name,
        e.team_name,
        e.play_type,
        e.tier::text                        AS tier,
        e.thumbnail_url,
        ts.serial_number,
        ts.price_usd,
        ts.sold_at,
        ts.marketplace
      FROM (
        SELECT s.edition_id, s.serial_number, s.price_usd, s.sold_at, s.marketplace
        FROM sales s
        WHERE s.collection_id = p_collection_id
          AND s.sold_at >= now() - interval '365 days'
          AND s.edition_id = ANY(v_edition_ids)
        ORDER BY s.sold_at DESC
        LIMIT v_safe_limit OFFSET v_safe_offset
      ) ts
      JOIN editions e ON e.id = ts.edition_id
      ORDER BY ts.sold_at DESC
    ) t;
  END IF;

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_set_activity(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_set_activity(uuid, text, integer, integer) TO service_role;

-- Post-condition: the function exists and answers the largest set.
DO $$
DECLARE v jsonb;
BEGIN
  SELECT public.get_set_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'base-set', 5, 0) INTO v;
  IF jsonb_typeof(v) <> 'array' THEN RAISE EXCEPTION 'get_set_activity did not return an array'; END IF;
END $$;
