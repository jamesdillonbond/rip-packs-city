-- get_team_activity: add a per-edition candidate path for NARROW teams.
--
-- anon-exec: public.get_team_activity(uuid, text, integer, integer) -- unchanged ACL: postgres/service_role only, no anon/authenticated EXECUTE.
--
-- WHY (measured 2026-09-01 ~21:1xZ, all numbers EXPLAIN (ANALYZE, BUFFERS) THROUGH the function):
--   The single candidate query walks sales_YYYY_collection_id_sold_at_idx backwards
--   and applies `edition_id = ANY(...)` as a post-index Filter. Its cost is therefore
--   a function of how RARE the team is, not how big it is:
--     detroit-shock        (  5 editions)  78,291 buffers / 6,953 ms
--     seattle-supersonics  ( 36 editions)  24,231 buffers / 8,476 ms   <-- over its own 8s budget
--     los-angeles-lakers   (639 editions)   5,537 buffers /    36 ms
--   The sales_2026 leg alone removed 98,725 rows by Filter to find 30 for detroit-shock.
--   93 of 171 team pages sit at <= 60 editions, i.e. in the pathological band, and the
--   route degrades the Market Activity section to an error state when the 8s cap trips.
--
-- WHAT WAS REFUTED FIRST (do not re-derive):
--   * plan_cache_mode = force_custom_plan: IDENTICAL 78,291 total buffers. Wall clock
--     halved (6,953 -> 3,907 ms) on a WARM CACHE only. Not a plan-shape problem.
--   * Replacing the query with the per-edition lateral UNCONDITIONALLY: for
--     los-angeles-lakers that is 20,706 buffers / 4,643 ms, i.e. 3.7x MORE buffers and
--     129x SLOWER than today. The lateral costs ~33 buffers per edition (three points:
--     5 -> 177, 36 -> 1,170, 639 -> 20,706), so it must be gated on the candidate count.
--
-- THE GATE: v_n_eds * (limit + offset) <= 2000, i.e. at most ~2,000 candidate rows
--   materialised. At the measured 1.73 buffers/row that is <= ~3,500 buffers, which is
--   below the 5,537 buffers the CURRENT shape spends on its BEST observed case. So below
--   the gate the new path is cheaper than anything the old path achieves; at or above it
--   the old path runs and behaviour is byte-identical to today.
--
-- CORRECTNESS: if an edition contributes k rows to the global top (limit+offset) by
--   sold_at DESC, then k <= limit+offset and those rows are within that edition's OWN top
--   (limit+offset). Taking limit+offset per edition therefore cannot drop a row the old
--   shape would have returned. Ordering among EQUAL sold_at values is unspecified in both
--   shapes (neither has a tiebreak) and is not made worse here.
--
-- REVERT: re-apply the body from
--   20260830xxxxxx / whatever is current at revert time, i.e. delete the IF branch and
--   keep only the ELSE block below. Concretely: replace the whole IF ... ELSE ... END IF
--   with just the ELSE block's SELECT. Signature, ACL, volatility and proconfig unchanged,
--   so no GRANT/REVOKE is involved in either direction.

CREATE OR REPLACE FUNCTION public.get_team_activity(p_collection_id uuid, p_team_slug text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
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
  SELECT array_agg(DISTINCT team_name) INTO v_variants
  FROM editions
  WHERE collection_id = p_collection_id
    AND team_name IS NOT NULL
    AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = p_team_slug;
  IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT array_agg(id) INTO v_edition_ids
  FROM editions
  WHERE collection_id = p_collection_id
    AND team_name = ANY(v_variants);
  IF v_edition_ids IS NULL THEN RETURN '[]'::jsonb; END IF;

  v_n_eds  := COALESCE(array_length(v_edition_ids, 1), 0);
  v_window := v_safe_limit + v_safe_offset;

  IF v_n_eds > 0 AND (v_n_eds::bigint * v_window::bigint) <= 2000 THEN
    -- NARROW TEAM: take each edition's own most-recent window via
    -- sales_YYYY_edition_id_sold_at_idx, then merge. Bounded by the gate above.
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
    -- WIDE TEAM: unchanged from the pre-2026-09-01 body. Do not "simplify" this away.
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

-- Structural post-condition: signature, language, volatility, security and proconfig
-- must be exactly what they were, and no anon/authenticated EXECUTE may have appeared.
DO $post$
DECLARE
  v_lang text; v_vol "char"; v_secdef boolean; v_cfg text;
  v_anon boolean; v_auth boolean; v_n int;
BEGIN
  SELECT l.lanname, p.provolatile, p.prosecdef, array_to_string(p.proconfig, ' | ')
    INTO v_lang, v_vol, v_secdef, v_cfg
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = 'public.get_team_activity(uuid,text,integer,integer)'::regprocedure;

  IF v_lang <> 'plpgsql' OR v_vol <> 's' OR NOT v_secdef THEN
    RAISE EXCEPTION 'post-condition failed: lang=% vol=% secdef=%', v_lang, v_vol, v_secdef;
  END IF;
  IF v_cfg IS DISTINCT FROM 'search_path=public | statement_timeout=8s' THEN
    RAISE EXCEPTION 'post-condition failed: proconfig drifted to %', v_cfg;
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_team_activity';
  IF v_n <> 1 THEN RAISE EXCEPTION 'post-condition failed: % overloads of get_team_activity', v_n; END IF;

  v_anon := has_function_privilege('anon', 'public.get_team_activity(uuid,text,integer,integer)', 'EXECUTE');
  v_auth := has_function_privilege('authenticated', 'public.get_team_activity(uuid,text,integer,integer)', 'EXECUTE');
  IF v_anon OR v_auth THEN
    RAISE EXCEPTION 'post-condition failed: EXECUTE leaked (anon=% authenticated=%)', v_anon, v_auth;
  END IF;
END
$post$;

-- Behavioural post-condition: RUN the new branch. A catalog-only check cannot see a
-- type mismatch inside RETURN/INTO (that trap cost a revert earlier today).
DO $behav$
DECLARE v_narrow jsonb; v_wide jsonb;
BEGIN
  v_narrow := public.get_team_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'detroit-shock', 30, 0);
  v_wide   := public.get_team_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'los-angeles-lakers', 30, 0);
  IF jsonb_typeof(v_narrow) <> 'array' OR jsonb_array_length(v_narrow) <> 30 THEN
    RAISE EXCEPTION 'post-condition failed: narrow path returned % rows', jsonb_array_length(v_narrow);
  END IF;
  IF jsonb_typeof(v_wide) <> 'array' OR jsonb_array_length(v_wide) <> 30 THEN
    RAISE EXCEPTION 'post-condition failed: wide path returned % rows', jsonb_array_length(v_wide);
  END IF;
  IF public.get_team_activity('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'no-such-team-xyz', 30, 0) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'post-condition failed: unknown team no longer returns []';
  END IF;
END
$behav$;