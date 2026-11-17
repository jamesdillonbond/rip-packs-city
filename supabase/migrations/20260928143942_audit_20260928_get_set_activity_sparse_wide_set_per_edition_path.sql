-- 2026-09-28 (PT) — the set page's Recent Sales panel timed out on WIDE, SPARSE
-- sets. Vercel logged `get_set_activity failed after retries: canceling statement
-- due to statement timeout — degrading to empty` 7× in 48 h (the page is honest
-- about it — three-state — but the panel is gone for that visitor).
--
-- CAUSE, measured: the WIDE path (editions × window > 2000) streams the
-- collection's (collection_id, sold_at DESC) index and heap-checks every row for
-- edition_id until it has a full window. The 09-25 header predicted it: "a COLD
-- wide set would walk deeper". Top Shot `2022-23-season-rewind` is 103 editions
-- with 77 sales in a year against 1.1M collection sales, so the stream walks the
-- whole year: 271,434–421,711 buffers warm, the 8 s timeout cold. All Day
-- `genesis` (352 editions, 0 sales in a year): 194,352.
--
-- FIX: one bounded pass over the collection's newest 5,000 sales in the year,
-- keeping this set's rows (stops at the window). Then:
--   * the window filled                  → those rows ARE the answer (no re-read);
--   * the collection's whole year < 5,000 → the pass saw all of it, so its rows
--                                           are the complete answer too;
--   * otherwise (big collection, sparse set) → each edition's own window through
--     idx_sales_edition with the SAME 365-day floor, merged.
-- Every branch returns the rows the old stream returned. The narrow path is the
-- previous body with a '-infinity' floor.
--
-- PROVED over the population before shipping (a pg_temp copy vs the live body):
-- all 673 narrow sets byte-identical at (20,0); all 62 wide sets the same 960
-- rows at (20,0) — 57 byte-identical, 5 reordered only among rows sharing one
-- sold_at; at (10,15) 59/62 identical, the 3 others swap one row with an EQUAL
-- sold_at at the window edge (the old ORDER BY has no tiebreak either).
-- Positive control: limit 19 vs 20 differs in exactly the 519 full-window sets.
-- COST over the 62 wide sets at (20,0), shared buffers: total 804,296 → 212,058;
-- max 271,434 → 12,853. 2 sets are materially dearer (5,373 → 8,676 and
-- 3,859 → 6,200 — dense enough that the old stream stopped early, too sparse
-- for the 5,000-row pass).
--
-- Revert: re-apply 20260925093248_audit_20260925_get_set_activity_the_set_pages_recent_sales_panel.sql
-- (same signature, CREATE OR REPLACE).

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
  v_head        sales[];
  v_year_rows   int;
  v_mode        text := 'per_edition';
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

  IF v_n_eds > 0 AND (v_n_eds::bigint * v_window::bigint) > 2000 THEN
    -- WIDE SET: one bounded pass over the collection's newest 5,000 sales in the
    -- year, keeping this set's rows; stops as soon as the window is full.
    SELECT array_agg(h.s ORDER BY (h.s).sold_at DESC) INTO v_head FROM (
      SELECT p.s
      FROM (
        SELECT s
        FROM sales s
        WHERE s.collection_id = p_collection_id
          AND s.sold_at >= now() - interval '365 days'
        ORDER BY s.sold_at DESC
        LIMIT 5000
      ) p
      WHERE (p.s).edition_id = ANY(v_edition_ids)
      LIMIT v_window
    ) h;

    IF COALESCE(array_length(v_head, 1), 0) >= v_window THEN
      v_mode := 'head';
    ELSE
      -- Did the pass see the collection's whole year? Then its rows are complete.
      SELECT count(*) INTO v_year_rows FROM (
        SELECT 1
        FROM sales s
        WHERE s.collection_id = p_collection_id
          AND s.sold_at >= now() - interval '365 days'
        LIMIT 5000
      ) y;
      IF v_year_rows < 5000 THEN
        v_mode := 'head';
      ELSE
        v_mode := 'per_edition_year';
      END IF;
    END IF;
  END IF;

  IF v_mode = 'head' THEN
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
        SELECT u.edition_id, u.serial_number, u.price_usd, u.sold_at, u.marketplace
        FROM unnest(v_head) u
        ORDER BY u.sold_at DESC
        LIMIT v_safe_limit OFFSET v_safe_offset
      ) ts
      JOIN editions e ON e.id = ts.edition_id
      ORDER BY ts.sold_at DESC
    ) t;
  ELSE
    -- NARROW SET, or a WIDE set too sparse for the pass: each edition's own
    -- most-recent window via idx_sales_edition, merged. A wide set keeps the
    -- 365-day floor as an index bound, so it returns what the stream would.
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
            AND s.sold_at >= CASE WHEN v_mode = 'per_edition_year'
                                  THEN now() - interval '365 days'
                                  ELSE '-infinity'::timestamptz END
          ORDER BY s.sold_at DESC
          LIMIT v_window
        ) cand
        ORDER BY cand.sold_at DESC
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

-- Post-condition: the largest set and the sparse wide set that timed out both answer.
DO $$
DECLARE v jsonb;
BEGIN
  SELECT public.get_set_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'base-set', 5, 0) INTO v;
  IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) <> 5 THEN RAISE EXCEPTION 'get_set_activity base-set did not return 5 rows'; END IF;
  SELECT public.get_set_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '2022-23-season-rewind', 20, 0) INTO v;
  IF jsonb_typeof(v) <> 'array' THEN RAISE EXCEPTION 'get_set_activity sparse wide set did not return an array'; END IF;
END $$;
