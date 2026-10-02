-- audit_20261002_wallet_intel_summary_plans_per_wallet_so_a_whale_gets_hash_joins
--
-- 2026-10-02 ~8:50 AM PT (Claude Code, cloud, autonomous pass). Follows 20261002152115
-- (same function, pricing leg moved to edition_fmv_current) by 3 minutes.
--
-- WHAT WAS WRONG. 20261002152115's leg measurement (50.6k → 10.5k buffers) did not show
-- up in the whole function: Rigged (0xf77bf547fccf6656, 38,666 Top Shot cache rows) still
-- read 420,797 buffers / 1.09 s through `SELECT get_wallet_intel_summary(…)`, while the
-- IDENTICAL body run as a statement with the wallet written in read 38,087 buffers / 0.48 s.
-- The difference is the plan: inside the SQL-language function the wallet is a parameter,
-- the planner estimates a typical wallet (a few hundred rows) and joins editions,
-- badge_editions and edition_fmv_current by per-row NESTED LOOPS — right for most wallets,
-- 11× the buffers for a whale, where hash joins over the 14k Top Shot editions are cheap.
-- Cold, that is the 8 s `/api/public/wallet-intel` timeout in the Vercel log (00:50 and
-- 02:08 AM PT), paired with get_wallet_collection_snapshot's on the same share-card load.
--
-- WHAT THIS DOES. The body is unchanged; it moves into a plpgsql wrapper that runs it via
-- `EXECUTE … USING lower(p_wallet)`. EXECUTE plans each call with the parameter's VALUE, so
-- the row estimate is the wallet's own and the join strategy follows it. `wallet` in the
-- payload is `$1` (the lower-cased input), as before.
--
-- MEASURED (EXPLAIN ANALYZE, BUFFERS, LARGE instance), the whole function:
--     Rigged  0xf77b…  420,797 buffers · 1,094 ms  →  40,472 buffers (12,761 read) · 2,144 ms *
--     founder 0xbd94…  171,534 buffers ·   645 ms  →  22,326 buffers ·               335 ms
--     empty wallet                                  →   2,413 buffers ·                11 ms
--   * the Rigged after-figure paid 12,761 cold page reads the before-figure had warm (0 read);
--     buffers, the cache-independent discriminator, fell 10.4×. Output byte-identical for
--     Rigged: 38,666 moments · ts_fmv 44,757.11 · squeezed 12,736 · rookies 3,218 · trophies 39.
--
-- ⚠ TRANSFERABLE: a SQL-language function whose parameter selects a WALLET (or any
-- heavy-tailed key) is planned for the average key. `EXPLAIN` on the body with a literal
-- measures a plan the function never runs; measure `SELECT fn(whale)` itself. The same shape
-- is in get_wallet_collection_snapshot (pinned; left for its own migration + pin update).
--
-- UNCHANGED: signature, SECURITY DEFINER, search_path, every output key, ordering, LIMIT 6,
-- ACL (anon/authenticated false, service_role true). No exception handler (nothing to record;
-- the R118 guard reads []). Not pinned.
--
-- REVERT: re-apply 20261002152115's SQL-language body (prosrc md5 cbeeef07f0f63dc5f314c6fddda2ce01).
--
-- anon-exec: unchanged (get_wallet_intel_summary) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (anon=false, authenticated=false, service_role=true verified live 2026-10-02), re-asserted below.

CREATE OR REPLACE FUNCTION public.get_wallet_intel_summary(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  -- Dynamic SQL on purpose: EXECUTE … USING plans the statement with the wallet's REAL
  -- row estimate, so an 18k-moment wallet gets hash joins (38k buffers) where the
  -- SQL-language body's generic plan gave it per-row nested loops (420k buffers).
  EXECUTE $q$
    WITH h AS (
      SELECT e.id AS edition_id, e.external_id, w.serial_number,
             COALESCE(e.player_name, '') AS player_name,
             COALESCE(e.set_name, '') AS set_name,
             e.tier::text AS tier,
             e.circulation_count, e.thumbnail_url
      FROM wallet_moments_cache w
      JOIN editions e ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
      WHERE w.wallet_address = $1
        AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    ),
    enr AS (
      SELECT h.*,
        (be.is_three_star_rookie OR be.has_rookie_mint OR be.play_tags::text ILIKE '%rookie%') AS is_rookie,
        CASE WHEN COALESCE(h.circulation_count, be.circulation_count, 0) > 0
          THEN round(100.0 * (COALESCE(be.locked,0) + COALESCE(be.burned,0))::numeric / NULLIF(COALESCE(h.circulation_count, be.circulation_count), 0)::numeric, 1)
          ELSE NULL END AS squeeze_pct,
        (h.serial_number = 1 OR h.circulation_count = 1) AS is_trophy,
        l.fmv_usd, l.confidence::text AS confidence
      FROM h
      LEFT JOIN badge_editions be ON be.external_id = h.external_id AND be.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      LEFT JOIN edition_fmv_current l ON l.edition_id = h.edition_id
    )
    SELECT jsonb_build_object(
      'wallet', $1,
      'ts_moments', (SELECT count(*) FROM enr),
      'ts_fmv', (SELECT round(COALESCE(sum(fmv_usd),0)::numeric, 2) FROM enr),
      'squeezed_count', (SELECT count(*) FROM enr WHERE squeeze_pct > 50),
      'rookie_count', (SELECT count(*) FROM enr WHERE is_rookie),
      'trophy_count', (SELECT count(*) FROM enr WHERE is_trophy),
      'highlights', (
        SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
          SELECT jsonb_build_object(
            'external_id', external_id, 'player_name', player_name, 'set_name', set_name,
            'tier', tier, 'serial_number', serial_number, 'circulation', circulation_count,
            'squeeze_pct', squeeze_pct, 'is_rookie', is_rookie, 'is_trophy', is_trophy,
            'fmv_usd', fmv_usd, 'confidence', confidence, 'thumbnail_url', thumbnail_url
          ) AS x
          FROM enr
          ORDER BY (COALESCE((squeeze_pct > 50)::int,0) + COALESCE(is_rookie::int,0) + COALESCE(is_trophy::int,0)) DESC,
                   squeeze_pct DESC NULLS LAST, fmv_usd DESC NULLS LAST
          LIMIT 6
        ) q
      )
    )
  $q$ INTO v USING lower(p_wallet);
  RETURN v;
END
$function$;

DO $mig$
DECLARE v jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.get_wallet_intel_summary(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_wallet_intel_summary(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_wallet_intel_summary(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_wallet_intel_summary ACL changed';
  END IF;
  v := public.get_wallet_intel_summary('0xBD94CADE097E50AC');
  IF v IS NULL OR NOT (v ? 'ts_moments' AND v ? 'ts_fmv' AND v ? 'squeezed_count' AND v ? 'rookie_count' AND v ? 'trophy_count' AND v ? 'highlights' AND v ? 'wallet') THEN
    RAISE EXCEPTION 'get_wallet_intel_summary shape changed: %', left(v::text, 300);
  END IF;
  IF v->>'wallet' <> '0xbd94cade097e50ac' THEN
    RAISE EXCEPTION 'wallet is not lower-cased: %', v->>'wallet';
  END IF;
  IF (v->>'ts_moments')::int <= 0 THEN
    RAISE EXCEPTION 'control wallet read 0 Top Shot moments — the join lost its rows';
  END IF;
END
$mig$;
