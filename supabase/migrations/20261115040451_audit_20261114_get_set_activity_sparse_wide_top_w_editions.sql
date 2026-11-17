-- 2026-11-14 (PT) — #252: a set page's Recent Sales panel timed out COLD on wide,
-- rarely-traded sets (21 timeouts / 7 d). Top Shot `holo-icon` (431 editions):
-- 16.6 s cold vs the function's 8 s statement_timeout; 21,176 blocks touched,
-- 5,053 read from disk, on the `per_edition_year` path — 431 per-edition heap
-- walks of up to W rows each.
--
-- FIX (exact, no precompute): a set's newest W sales can only come from the W
-- editions whose LATEST sale in the year is newest — an edition ranked below W
-- has W editions each holding a newer sale. So, on the sparse-wide path only:
--   step 1  each edition's latest sold_at, INDEX-ONLY on
--           sales_<year>_edition_id_sold_at_idx (holo-icon: 2,845 blocks, 9 heap
--           fetches, ~470 cold reads);
--   step 2  full rows for the top-W editions alone (rank() keeps ties).
-- Step 1 drops the `collection_id` filter to stay index-only, so it trusts that a
-- sale's collection matches its edition's (0 violations in 400 d on 11-14; no
-- constraint). The body CHECKS rather than trusts: when editions were excluded,
-- the answer is used only if ≥ W rows sit at or above the cutoff (every excluded
-- edition's rows are older); otherwise it takes the old full per-edition read.
-- The head pass, the narrow path and the output shape are unchanged.
--
-- PROVED over the population before shipping (pg_temp copy vs the live body,
-- every wide set, 2026-11-14 ~8:15 PM PT):
--   Top Shot 49 sets × (20,0),(10,15),(30,0) = 147 calls: 0 errors, identical
--   sold_at sequence in 147/147, identical row set in 146/147 (nba-cup (10,15)
--   swaps one row with an EQUAL sold_at at the window edge — the old ORDER BY has
--   no tiebreak either, as the 09-28 proof recorded); 131 byte-identical.
--   All Day 27 / Panini 119 / Candy 31 / Golazos 3 sets × (20,0),(10,15) =
--   360 calls: all byte-identical, 0 errors.
-- Positive controls (planted defects): 18 of 49 Top Shot wide sets take the new
-- branch; with candidates cut to rank 1 and the check bypassed, 18 sets diverge;
-- with the check on, 17 of those 18 fall back to the full read.
--
-- Revert: re-apply 20260928143942_audit_20260928_get_set_activity_sparse_wide_set_per_edition_path.sql
-- (same signature, CREATE OR REPLACE; its body md5 = a3fbff8683fdb6b0a27dc87af74a4107).

DO $$
DECLARE v text;
BEGIN
  SELECT md5(prosrc) INTO v FROM pg_proc WHERE oid = 'public.get_set_activity(uuid,text,integer,integer)'::regprocedure;
  IF v IS DISTINCT FROM 'a3fbff8683fdb6b0a27dc87af74a4107' AND v IS DISTINCT FROM 'f4ee01774c80cbc8276282dec7e38a7e' THEN
    RAISE EXCEPTION 'get_set_activity live body md5 % is neither the 09-28 base nor this file — another session changed it; rebase first', v;
  END IF;
END $$;

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
  v_cand_ids    uuid[];
  v_cutoff      timestamptz;
  v_n_active    int;
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
        -- Big collection, sparse set. The set's newest W sales can only come
        -- from the W editions whose LATEST sale in the year is newest (an
        -- edition ranked below W has W editions each holding a newer sale).
        -- Step 1 reads each edition's latest sold_at INDEX-ONLY (no heap);
        -- step 2 reads full rows for those editions alone.
        SELECT array_agg(r.id) FILTER (WHERE r.rk <= v_window),
               min(r.latest)   FILTER (WHERE r.rk <= v_window),
               count(*)
          INTO v_cand_ids, v_cutoff, v_n_active
        FROM (
          SELECT ed.id, l.sold_at AS latest,
                 rank() OVER (ORDER BY l.sold_at DESC) AS rk
          FROM unnest(v_edition_ids) AS ed(id)
          CROSS JOIN LATERAL (
            SELECT s.sold_at
            FROM sales s
            WHERE s.edition_id = ed.id
              AND s.sold_at >= now() - interval '365 days'
            ORDER BY s.sold_at DESC
            LIMIT 1
          ) l
        ) r;

        SELECT array_agg(h.s ORDER BY (h.s).sold_at DESC) INTO v_head FROM (
          SELECT c.s
          FROM unnest(COALESCE(v_cand_ids, '{}'::uuid[])) AS ed(id)
          CROSS JOIN LATERAL (
            SELECT s
            FROM sales s
            WHERE s.collection_id = p_collection_id
              AND s.edition_id = ed.id
              AND s.sold_at >= now() - interval '365 days'
            ORDER BY s.sold_at DESC
            LIMIT v_window
          ) c
          ORDER BY (c.s).sold_at DESC
          LIMIT v_window
        ) h;

        -- Step 1 has no collection filter (index-only), so it trusts that a
        -- sale's collection matches its edition's. Check, don't trust: when
        -- editions were excluded, the answer is exact only if W rows sit at or
        -- above the cutoff (every excluded row is older). Otherwise take the
        -- full per-edition read.
        IF COALESCE(v_n_active, 0) <= v_window
           OR (SELECT count(*) FROM unnest(v_head) u WHERE u.sold_at >= v_cutoff) >= v_window THEN
          v_mode := 'head';
        ELSE
          v_mode := 'per_edition_year';
        END IF;
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

-- Post-conditions: the reported set and the 09-28 sparse wide set answer full
-- windows, the largest set still answers, and the privileges held.
DO $$
DECLARE v jsonb;
BEGIN
  SELECT public.get_set_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'base-set', 5, 0) INTO v;
  IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) <> 5 THEN RAISE EXCEPTION 'get_set_activity base-set did not return 5 rows'; END IF;
  SELECT public.get_set_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'holo-icon', 30, 0) INTO v;
  IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v) <> 30 THEN RAISE EXCEPTION 'get_set_activity holo-icon did not return 30 rows'; END IF;
  SELECT public.get_set_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '2022-23-season-rewind', 20, 0) INTO v;
  IF jsonb_typeof(v) <> 'array' THEN RAISE EXCEPTION 'get_set_activity sparse wide set did not return an array'; END IF;
  IF has_function_privilege('anon', 'public.get_set_activity(uuid,text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_set_activity(uuid,text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_set_activity is executable by anon/authenticated';
  END IF;
END $$;
