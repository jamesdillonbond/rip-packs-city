-- audit_20261009_wallet_rips_rebuild_plans_per_wallet
--
-- 2026-10-09 ~10:00 AM PT (Claude Code, cloud). The real cause of the rpc-chain-arrival-pack-pulls
-- wedge (5+ nights; the 9:41 AM PT tick still died at 120 s in the rebuild after 20261009162222).
--
-- MEASURED (rolled-back DO blocks, RAISE LOG timings read back from postgres_logs):
--   · rebuild_wallet_reconstructed_rips is fast ALONE: 0.4-4.5 s per wallet, first call in a session.
--   · Called 11 times in ONE session (what apply_chain_arrival_pack_pulls and
--     rebuild_saved_wallet_reconstructed_rips both do), PL/pgSQL switches its WITH pulls ... INSERT to
--     the cached GENERIC plan from the 6th call (an average wallet's plan): calls 6-8 went 0.08 -> 1.01 s,
--     0.34 -> 4.13 s, 0.18 -> 2.46 s, and call 11 -- 0xf77b..., 32,703 pack pulls -- did not finish in
--     60 s (cancelled). The same 11 calls with plan_cache_mode = force_custom_plan: call 11 took 1.86 s.
--   So any run that reached the big wallet after 5 others hung past pg_cron's 120 s wall and rolled back.
--   (The 20261009162222 bound stays: it fixed the separate 54 s re-check of history.)
--
-- WHAT THIS DOES. Adds SET plan_cache_mode TO 'force_custom_plan' to the function -- the repo's
-- documented remedy (20260901203559). Body unchanged; every call is planned for ITS wallet.
--
-- anon-exec: unchanged (rebuild_wallet_reconstructed_rips) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-10-09).
--
-- Base verified: live prosrc md5 (whitespace-normalised) 3345ce8c5203be193e59f75a0d153f1a = the body in
-- 20260926170000, the newest migration defining this function.
--
-- REVERT: ALTER FUNCTION public.rebuild_wallet_reconstructed_rips(text) RESET plan_cache_mode;
--
-- APPLIED AS: ALTER FUNCTION public.rebuild_wallet_reconstructed_rips(text) SET plan_cache_mode TO
-- 'force_custom_plan' -- the Supabase MCP held this full CREATE OR REPLACE for confirmation on the
-- DELETE in its (unchanged) body. The live object equals this file: prosrc md5 3345ce8c... unchanged,
-- proconfig {search_path=public, statement_timeout=110s, plan_cache_mode=force_custom_plan}.

CREATE OR REPLACE FUNCTION public.rebuild_wallet_reconstructed_rips(p_wallet text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  v_wallet text := lower(trim(coalesce(p_wallet, '')));
  v_started timestamptz := clock_timestamp();
  v_written int := 0;
  v_deleted int := 0;
  v_valued int := 0;
BEGIN
  IF v_wallet = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wallet required');
  END IF;

  WITH pulls AS (
    -- one delivery per moment: its earliest pack-pull row for this wallet
    SELECT DISTINCT ON (ma.collection_id, ma.nft_id) ma.collection_id, ma.nft_id, ma.acquired_date
    FROM public.moment_acquisitions ma
    WHERE ma.wallet = v_wallet
      AND ma.acquisition_method = 'pack_pull'
      AND ma.acquired_date IS NOT NULL
      AND ma.collection_id IS NOT NULL
    ORDER BY ma.collection_id, ma.nft_id, ma.acquired_date
  ), gapped AS (
    SELECT p.*,
           p.acquired_date - lag(p.acquired_date) OVER (PARTITION BY p.collection_id ORDER BY p.acquired_date, p.nft_id) AS gap
    FROM pulls p
  ), numbered AS (
    SELECT g.*,
           sum(CASE WHEN g.gap IS NULL OR g.gap > interval '3 seconds' THEN 1 ELSE 0 END)
             OVER (PARTITION BY g.collection_id ORDER BY g.acquired_date, g.nft_id) AS burst
    FROM gapped g
  ), bursts AS (
    SELECT n.collection_id, n.burst,
           min(n.acquired_date) AS opened_at,
           array_agg(n.nft_id ORDER BY n.acquired_date, n.nft_id) AS nft_ids
    FROM numbered n
    GROUP BY n.collection_id, n.burst
  ), fresh AS (
    -- not already a row: no moment of the burst is in a known pack's pull list,
    -- and none arrived through the on-chain rip ingest
    SELECT b.*
    FROM bursts b
    WHERE NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                       WHERE o.collection_id = b.collection_id AND o.nft_id = ANY (b.nft_ids))
      AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions m2
                       WHERE m2.wallet = v_wallet AND m2.collection_id = b.collection_id
                         AND m2.nft_id = ANY (b.nft_ids) AND m2.source = 'flowty_ingest')
  ), priced AS (
    SELECT f.collection_id, f.opened_at, f.nft_ids,
           f.nft_ids[1] AS first_nft,
           cardinality(f.nft_ids) AS n_pulls,
           count(ed.edition_id) AS n_resolved,
           count(fv.fmv_usd) AS n_priced,
           sum(fv.fmv_usd) AS total
    FROM fresh f
    CROSS JOIN LATERAL unnest(f.nft_ids) AS u(nft_id)
    LEFT JOIN LATERAL (
      SELECT coalesce(
        (SELECT mo.edition_id FROM public.moments mo
          WHERE mo.nft_id = u.nft_id AND mo.collection_id = f.collection_id AND mo.edition_id IS NOT NULL LIMIT 1),
        (SELECT e.id FROM public.wallet_moments_cache w
           JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
          WHERE w.moment_id = u.nft_id AND w.collection_id = f.collection_id AND w.edition_key IS NOT NULL LIMIT 1)
      ) AS edition_id
    ) ed ON true
    LEFT JOIN LATERAL (
      SELECT CASE WHEN s.fmv_usd > 0 THEN s.fmv_usd END AS fmv_usd
      FROM public.fmv_snapshots s
      WHERE ed.edition_id IS NOT NULL
        AND s.collection_id = f.collection_id AND s.edition_id = ed.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fv ON true
    GROUP BY f.collection_id, f.opened_at, f.nft_ids
  ), ins AS (
    INSERT INTO public.wallet_reconstructed_rips
      (wallet, collection_id, burst_id, opened_at, moments_pulled, nft_ids, n_resolved, n_priced, pull_value_usd, computed_at)
    SELECT v_wallet, p.collection_id, 'burst:' || p.first_nft, p.opened_at, p.n_pulls, p.nft_ids,
           p.n_resolved, p.n_priced,
           CASE WHEN p.n_priced = p.n_pulls THEN round(p.total, 2) END,
           v_started
    FROM priced p
    ON CONFLICT (wallet, collection_id, burst_id) DO UPDATE
      SET opened_at = EXCLUDED.opened_at, moments_pulled = EXCLUDED.moments_pulled,
          nft_ids = EXCLUDED.nft_ids, n_resolved = EXCLUDED.n_resolved, n_priced = EXCLUDED.n_priced,
          pull_value_usd = EXCLUDED.pull_value_usd, computed_at = EXCLUDED.computed_at
    RETURNING pull_value_usd
  )
  SELECT count(*), count(pull_value_usd) INTO v_written, v_valued FROM ins;

  -- write first, then delete only this wallet's rows this run did not write
  DELETE FROM public.wallet_reconstructed_rips
   WHERE wallet = v_wallet AND computed_at < v_started;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'wallet', v_wallet, 'reconstructed', v_written,
                            'valued', v_valued, 'retired', v_deleted);
END;
$function$;
