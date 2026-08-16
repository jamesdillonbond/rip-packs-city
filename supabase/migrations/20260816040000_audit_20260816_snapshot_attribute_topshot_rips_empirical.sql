-- Snapshot migration: public.attribute_topshot_rips_empirical(integer).
--
-- pg_cron jobid 64 `rpc-attribute-pack-rips-empirical` @ `10 3 * * *`, invoked as
-- `SELECT public.attribute_topshot_rips_empirical(20000)`. Applied to prod via
-- the Supabase MCP with no committed migration file, which made it UNPINNABLE.
-- This commits the CURRENT LIVE definition verbatim (pg_get_functiondef,
-- 2026-08-16, md5 1fea4ad6bec5386fdae1688106e0b268). Applying it is a no-op.
--
-- ── WHAT IT DOES, AND WHY THE STAKES ARE HIGH ──────────────────────────────
-- It INFERS which pack distribution an unattributed Top Shot rip came from, by
-- matching the rip's editions against the edition pools observed in rips whose
-- distribution is already KNOWN. Attribution feeds pack EV, which feeds a public
-- +EV buy signal — so a rip attached to the wrong distribution pollutes that
-- distribution's pool and moves a number collectors act on.
--
-- Live split (2026-08-16): rip_dist/high 36,464 · empirical_subset/medium 1,001
-- · live_pool_subset/medium 1. So this function produces ~2.7% of attributions,
-- every one of them an INFERENCE sitting beside 36k observations.
--
-- ── THE FIVE THINGS THAT KEEP AN INFERENCE HONEST ──────────────────────────
--
--   1. ⚠ NO FEEDBACK LOOP. `dist_support` and `emp_pool` both read
--      `method = 'rip_dist'` ONLY. The reference pools are built exclusively
--      from GROUND TRUTH, never from this function's own output. Widening either
--      to all methods would make each inference evidence for the next, and a
--      single bad attribution would compound outward through the pools with
--      nothing to stop it. This is the most important line in the function and
--      the easiest to "simplify" away.
--   2. `HAVING count(*) >= 20` — a distribution with a thin observed pool is not
--      used as a reference at all. Its pool would be mostly unobserved, so a
--      candidate rip could not meaningfully fail to match it.
--   3. `rc ... HAVING count(*) >= 2` — a rip with ONE known edition is not
--      identifying, and is skipped.
--   4. `p.matched = rc.n` — EVERY edition in the rip must be in that
--      distribution's pool. A partial match is not a match.
--   5. ⚠ `uniq ... HAVING count(*) = 1` — if the rip fully matches MORE THAN ONE
--      distribution, it is left unattributed rather than assigned to one of them.
--      Note `min(dist_id)` is only reachable once that HAVING has proved there is
--      exactly one candidate: it is a syntactic requirement of the GROUP BY, NOT
--      a tie-break, and reading it as a tie-break is the mistake to avoid. Same
--      shape as the HAVING in bridge_pinnacle_sales_editions.
--
-- Plus: `ON CONFLICT (rip_id) DO NOTHING` never overwrites an existing
-- attribution, so a high-confidence `rip_dist` row always survives; the rows are
-- labelled `empirical_subset` / `medium` so a consumer can tell an inference from
-- an observation; and `v_safe` clamps the caller's limit at BOTH ends
-- (NULL -> 8000, then 1..20000).
--
-- REVERT: a snapshot of what is already live, so reverting the FILE changes
-- nothing in prod. To remove the function:
--   DROP FUNCTION public.attribute_topshot_rips_empirical(integer);
-- (plus unscheduling pg_cron jobid 64). To undo its writes:
--   DELETE FROM public.topshot_pack_rip_attribution WHERE method = 'empirical_subset';

CREATE OR REPLACE FUNCTION public.attribute_topshot_rips_empirical(p_limit integer DEFAULT 8000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_cid uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_inserted int := 0;
  v_safe int := LEAST(GREATEST(COALESCE(p_limit,8000),1),20000);
BEGIN
  WITH
  dist_support AS (
    SELECT dist_id FROM public.topshot_pack_rip_attribution
    WHERE method='rip_dist' GROUP BY 1 HAVING count(*) >= 20
  ),
  emp_pool AS (
    SELECT a.dist_id, m.edition_id
    FROM public.topshot_pack_rip_attribution a
    JOIN dist_support ds ON ds.dist_id = a.dist_id
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = a.rip_id
    JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = v_cid
    WHERE a.method='rip_dist' AND m.edition_id IS NOT NULL
    GROUP BY 1,2
  ),
  cand AS (
    SELECT r.id FROM public.pack_rips r
    WHERE r.collection_id = v_cid AND r.dist_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.topshot_pack_rip_attribution a WHERE a.rip_id = r.id)
    ORDER BY random()
    LIMIT v_safe
  ),
  re AS (
    SELECT c.id AS rip_id, m.edition_id
    FROM cand c
    JOIN public.moment_acquisitions ma ON ma.source_pack_rip_id = c.id
    JOIN public.moments m ON m.nft_id = ma.nft_id AND m.collection_id = v_cid
    WHERE m.edition_id IS NOT NULL
    GROUP BY 1,2
  ),
  rc AS (SELECT rip_id, count(*) n FROM re GROUP BY 1 HAVING count(*) >= 2),
  pair AS (
    SELECT re.rip_id, ep.dist_id, count(*) matched
    FROM re JOIN rc ON rc.rip_id = re.rip_id
    JOIN emp_pool ep ON ep.edition_id = re.edition_id
    GROUP BY 1,2
  ),
  full_match AS (
    SELECT p.rip_id, p.dist_id FROM pair p JOIN rc ON rc.rip_id = p.rip_id
    WHERE p.matched = rc.n
  ),
  uniq AS (
    SELECT rip_id, min(dist_id) AS dist_id FROM full_match GROUP BY rip_id HAVING count(*) = 1
  ),
  ins AS (
    INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence, n_editions)
    SELECT u.rip_id, u.dist_id, 'empirical_subset', 'medium', rc.n
    FROM uniq u JOIN rc ON rc.rip_id = u.rip_id
    ON CONFLICT (rip_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN jsonb_build_object('inserted', v_inserted, 'limit', v_safe, 'finished_at', now());
END;
$function$;
