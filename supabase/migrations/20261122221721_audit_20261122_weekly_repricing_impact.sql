-- audit_20261122_weekly_repricing_impact — 2026-11-22 ~2:17 PM PT (Claude Code cloud, autonomous pass; Trevor: "Fix any issues
-- you encounter").
--
-- WHY. The weekly portfolio email's FIRST send is Mon 11-23 8:33 AM PT. Reading tomorrow's movers
-- (get_weekly_portfolio_movers(0,7), 11-22 ~2:30 PM PT): two members "−49.6% this week", others −43 / −39 / −24 / −20 %.
-- Moment counts flat; the step is 11-17 → 11-18 — the six 11-16/11-17 FMV restatement migrations (ASK_ONLY old-sale
-- and low-mint caps, Top Shot STALE premium-serial cap; fmv_restatements: ~1,000 editions, $290k → $142k summed).
-- Decomposed per member over the movers' own window: the top "−49.6 %" is −$27,587 of OUR price corrections on 18
-- held editions + −$10,032 everything else; the largest portfolio −$34,597 of −$52,384. An email reading "Down 49.6 %
-- this week" with no word of that tells a member the market halved their portfolio.
--
-- WHAT. get_weekly_repricing_impact(owner_key, prior_date, latest_date): for the member's saved wallets, the sum over
-- currently held moments of (old_fmv − new_fmv) for every fmv_restatements row of that moment's edition (collection-
-- scoped join, #142) whose restated_at falls between the two snapshot rows' created_at — the same window the weekly
-- delta measures. Returns {delta_usd (≤ 0 when prices were lowered), editions, moments}. NULL when either snapshot row
-- is missing (unknown — the caller must not send a bare delta then).
-- Approximation, stated in the email copy ("about"): restatements are edition-level prices; a held moment's own FMV can
-- differ by serial.
--
-- anon-exec: REVOKED — reads a member's saved wallets by owner key; service_role only (the weekly-digest route).
-- REVERT: DROP FUNCTION public.get_weekly_repricing_impact(text, date, date);

CREATE OR REPLACE FUNCTION public.get_weekly_repricing_impact(p_owner_key text, p_prior_date date, p_latest_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH win AS (
    SELECT
      (SELECT created_at FROM public.portfolio_snapshots WHERE owner_key = p_owner_key AND snapshot_date = p_prior_date) AS t0,
      (SELECT created_at FROM public.portfolio_snapshots WHERE owner_key = p_owner_key AND snapshot_date = p_latest_date) AS t1
  ),
  wallets AS (
    SELECT array_agg(DISTINCT sw.wallet_addr) AS a
    FROM public.saved_wallets sw
    WHERE sw.user_id::text = p_owner_key
  ),
  r AS (
    SELECT c.id AS collection_id, fr.ext_id, (fr.old_fmv_usd - fr.new_fmv_usd) AS drop_usd
    FROM public.fmv_restatements fr
    JOIN public.collections c ON c.slug = fr.collection_slug
    CROSS JOIN win
    WHERE fr.restated_at > win.t0 AND fr.restated_at <= win.t1
      AND fr.old_fmv_usd IS NOT NULL AND fr.new_fmv_usd IS NOT NULL
  ),
  hit AS (
    SELECT r.collection_id, r.ext_id, r.drop_usd, wmc.wallet_address
    FROM r
    JOIN public.wallet_moments_cache wmc
      ON wmc.collection_id = r.collection_id AND wmc.edition_key = r.ext_id
    WHERE wmc.wallet_address = ANY ((SELECT a FROM wallets)::text[])
      AND wmc.fmv_usd IS NOT NULL AND wmc.fmv_usd > 0
  )
  SELECT CASE WHEN (SELECT t0 FROM win) IS NULL OR (SELECT t1 FROM win) IS NULL THEN NULL
    ELSE jsonb_build_object(
      'delta_usd', round(COALESCE(-(SELECT sum(drop_usd) FROM hit), 0), 2),
      'editions',  (SELECT count(DISTINCT (collection_id, ext_id)) FROM hit),
      'moments',   (SELECT count(*) FROM hit))
  END
$function$;

REVOKE ALL ON FUNCTION public.get_weekly_repricing_impact(text, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_weekly_repricing_impact(text, date, date) TO service_role;
