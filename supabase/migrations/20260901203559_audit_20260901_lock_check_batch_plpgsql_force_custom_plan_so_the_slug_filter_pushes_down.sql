-- audit_20260901_lock_check_batch_plpgsql_force_custom_plan_so_the_slug_filter_pushes_down
-- anon-exec: get_lock_check_batch — SECURITY DEFINER, service_role-only. ACL measured 2026-09-01:
-- postgres=X, service_role=X, anon EXECUTE = false. The signature and RETURNS TABLE shape are IDENTICAL,
-- so CREATE OR REPLACE preserves that ACL; this migration changes LANGUAGE + plan_cache_mode only.
--
-- WHY (measured 2026-09-01): #5 consumer on the instance — 21,261 shared_blks_read and 16.5 s per call,
-- ~97 calls/day (~17 GB/day). The query text is NOT the problem. The PLAN is.
--
-- ⛔⛔ THIS IS THE `LANGUAGE sql` PARAM-BLIND TRAP, MEASURED AGAIN. The function ends with
--     WHERE (p_collection_slug IS NULL OR c.slug = p_collection_slug)
-- and `LANGUAGE sql` functions are planned ONCE, generically, without the argument values. A generic
-- plan cannot evaluate `$1 IS NULL OR c.slug = $1` at plan time, so it must assume the predicate may
-- match ALL SEVEN collections — and the CROSS JOIN LATERAL below it therefore runs seven times, doing
-- 584 hot wallets x 7 = ~4,088 index probes, and the filter then throws six sevenths of that away.
--
-- Side-by-side, same arguments ('nba_top_shot', 50, 7), same 50 rows out:
--     through the FUNCTION (generic plan) ......... 15,711 buffers ... 8,808 ms
--     the same body with the slug as a LITERAL ....  3,204 buffers ... 1,324 ms
-- The literal plan shows exactly what the generic one cannot do:
--     Seq Scan on collections c  Filter: (slug = 'nba_top_shot')  Rows Removed by Filter: 6
-- One collection reaches the lateral instead of seven. **4.9x, from plan shape alone.**
--
-- ⚠ THE PRODUCTION CALLER NEVER PASSES NULL. app/api/cron/lock-check-batch/route.ts calls this
-- per-slug for exactly two collections (LOCK_CHECK_SLUGS = ['nba_top_shot','disney_pinnacle']), so
-- every real call could have been a one-collection plan and none of them were.
--
-- FIX: plpgsql + `SET plan_cache_mode TO 'force_custom_plan'`, which is the documented remedy for this
-- exact trap (memory: sql-language-functions-are-planned-param-blind). A custom plan is built per call
-- WITH the argument values, so the slug filter is pushed to the `collections` scan and the lateral runs
-- once. ⚠ The GUC was verified settable here (context = 'user') before relying on it.
--
-- ⚠ ONE REAL CODE CHANGE, AND IT IS A CAST, NOT A SEMANTIC EDIT: `ranked.cslug::text`.
-- `collections.slug` is `character varying(50)` while this function's RETURNS TABLE declares
-- `out_collection_slug text`. `LANGUAGE sql` accepted that silently (binary-coercible); plpgsql's
-- RETURN QUERY is STRICT about result types and raised
--     42804: Returned type character varying(50) does not match expected type text in column 4
-- The first apply of this migration was ROLLED BACK by its own behavioural post-state because of it —
-- which is exactly why that post-state runs the function instead of only reading the catalog. The cast
-- changes no value, only the declared type.
--
-- ⛔ THE QUERY BODY IS OTHERWISE UNCHANGED — character for character, including the deliberate
-- `p_collection_slug IS NULL OR ...` form (still needed: NULL remains a legal argument and must still
-- mean "all collections"), the `LIMIT p_limit` inside the hot-wallet lateral, and the dedup/rank tail.
-- Do not "simplify" the predicate to `c.slug = p_collection_slug`.
--
-- ⛔ AND DO NOT LOWER THE INNER `LIMIT p_limit`. In the worst case a single hot wallet legitimately
-- supplies every output row, so that limit is load-bearing for correctness, not a tuning knob. The
-- observed shape is 584 loops returning ~21 rows each (11,978 rows) top-N sorted down to 50.
--
-- EXIT CONDITION (next pass):
--   SELECT * FROM public.ops_pgss_delta('3 hours', 60) WHERE q ILIKE '%get_lock_check_batch%';
--   PASS: blocks/call falls from ~21,261 toward ~3,500.
--   ⚠ Judge on blocks/call, not wall-clock. FALSIFIER: if it stays near 21,261 the custom plan is not
--   being taken — re-run `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM get_lock_check_batch('nba_top_shot',50,7)`
--   and confirm total buffers, then check proconfig still carries plan_cache_mode.
--
-- REVERT: re-create with `LANGUAGE sql`, without the plan_cache_mode entry, and without the ::text cast
--         (LANGUAGE sql does not need it) — the body is otherwise byte-identical to the pre-2026-09-01 one.

CREATE OR REPLACE FUNCTION public.get_lock_check_batch(p_collection_slug text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_max_age_days integer DEFAULT 7)
 RETURNS TABLE(out_wallet_address text, out_moment_id text, out_collection_id uuid, out_collection_slug text, out_edition_key text, out_is_priority boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
BEGIN
  -- ⚠ force_custom_plan (above) is the whole point: it lets the planner SEE p_collection_slug and push
  -- the `c.slug = p_collection_slug` restriction onto the collections scan, so the CROSS JOIN LATERAL
  -- runs for ONE collection instead of all seven. Measured 15,711 -> 3,204 buffers. Remove it and the
  -- regression is silent — same rows out, ~5x the I/O.
  RETURN QUERY
  WITH hot AS (
    SELECT seeded_wallets.wallet_address AS addr FROM seeded_wallets
    UNION
    SELECT saved_wallets.wallet_addr FROM saved_wallets
    UNION
    SELECT linked_accounts.parent_addr FROM linked_accounts
    UNION
    SELECT linked_accounts.child_addr FROM linked_accounts
  ),
  cand AS (
    SELECT c.id AS cid, c.slug AS cslug,
           x.wallet_address, x.moment_id, x.edition_key, x.lock_checked_at, x.forced_priority
    FROM collections c
    CROSS JOIN LATERAL (
      ( SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at, false AS forced_priority
        FROM wallet_moments_cache w
        WHERE w.collection_id = c.id
          AND (w.lock_checked_at IS NULL
               OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
        ORDER BY w.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
      UNION ALL
      ( SELECT w2.wallet_address, w2.moment_id, w2.edition_key, w2.lock_checked_at, true AS forced_priority
        FROM hot h
        CROSS JOIN LATERAL (
          SELECT w.wallet_address, w.moment_id, w.edition_key, w.lock_checked_at
          FROM wallet_moments_cache w
          WHERE w.wallet_address = h.addr
            AND w.collection_id = c.id
            AND (w.lock_checked_at IS NULL
                 OR w.lock_checked_at < NOW() - (p_max_age_days || ' days')::interval)
          ORDER BY w.lock_checked_at ASC NULLS FIRST
          LIMIT p_limit
        ) w2
        ORDER BY w2.lock_checked_at ASC NULLS FIRST
        LIMIT p_limit )
    ) x
    WHERE (p_collection_slug IS NULL OR c.slug = p_collection_slug)
  ),
  dedup AS (
    SELECT cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key,
           bool_or(cand.forced_priority) AS is_priority,
           min(cand.lock_checked_at) AS lock_checked_at
    FROM cand
    GROUP BY cand.wallet_address, cand.moment_id, cand.cid, cand.cslug, cand.edition_key
  ),
  ranked AS (
    SELECT dedup.wallet_address, dedup.moment_id, dedup.cid, dedup.cslug, dedup.edition_key, dedup.is_priority,
      ROW_NUMBER() OVER (
        PARTITION BY dedup.cid
        ORDER BY dedup.is_priority DESC, dedup.lock_checked_at ASC NULLS FIRST
      ) AS rn
    FROM dedup
  )
  -- ::text — see the header. collections.slug is varchar(50); plpgsql RETURN QUERY is strict.
  SELECT ranked.wallet_address, ranked.moment_id, ranked.cid, ranked.cslug::text, ranked.edition_key, ranked.is_priority
  FROM ranked
  ORDER BY ranked.rn, ranked.cid
  LIMIT p_limit;
END;
$function$;

DO $mig$
DECLARE
  v_cfg text[];
  v_lang name;
  v_rows int;
  v_slugs int;
BEGIN
  SELECT p.proconfig, l.lanname INTO v_cfg, v_lang
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname = 'public' AND p.proname = 'get_lock_check_batch';

  IF v_lang <> 'plpgsql' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected plpgsql, got %', v_lang;
  END IF;
  -- The GUC is the entire fix. Assert it survived, so a later edit cannot drop it silently.
  IF NOT ('plan_cache_mode=force_custom_plan' = ANY(v_cfg)) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: plan_cache_mode=force_custom_plan missing from proconfig (%)', v_cfg;
  END IF;
  IF NOT ('statement_timeout=120s' = ANY(v_cfg)) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the 120s statement_timeout was lost';
  END IF;
  IF has_function_privilege('anon', 'public.get_lock_check_batch(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: anon gained EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.get_lock_check_batch(text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-STATE FAILED: service_role LOST EXECUTE — the caller would 403';
  END IF;

  -- BEHAVIOURAL post-state — this is what caught the varchar/text mismatch on the first apply.
  -- A catalog read would have passed it.
  SELECT count(*) INTO v_rows FROM public.get_lock_check_batch('nba_top_shot', 50, 7);
  IF v_rows <> 50 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected 50 candidate rows for nba_top_shot, got %', v_rows;
  END IF;

  -- The per-slug contract the route depends on: asking for one slug returns only that slug.
  SELECT count(DISTINCT out_collection_slug) INTO v_slugs
  FROM public.get_lock_check_batch('disney_pinnacle', 50, 7);
  IF v_slugs <> 1 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: per-slug call returned % distinct slugs, expected 1', v_slugs;
  END IF;
END
$mig$;