-- Buyback-wallet analytics for a calendar-to-date period.
--
-- Wallet scope is driven off the seeded_wallets 'secondary_buyback' TAG, never a
-- hardcoded address list, so a third buyback wallet appears the day it is
-- tagged. 0xb6f2481eba4df97b is deliberately OUT of scope: it carries
-- 'pack_inventory', is a pack-distribution account rather than a buyback
-- account, and none of its 43,675 rows resolve to an edition.
--
-- THE HONESTY CONTRACT, enforced by the return shape rather than by prose:
--   * spend_usd NEVER travels without priced_acquisitions beside it, at every
--     level (totals, per wallet, per edition, per day). The main buyback wallet
--     has ZERO priced acquisitions, so its spend is UNKNOWABLE, not $0 --
--     summing spend_usd alone reports the programme at ~$0.05/moment.
--   * spend_known is an explicit boolean so a consumer cannot infer "no spend"
--     from a null/zero it failed to interpret.
--   * seller leaderboards are built ONLY from priced marketplace rows and carry
--     their own coverage counts, because 100% of snapshot_diff rows have a NULL
--     counterparty -- "who they buy from most" is structurally unanswerable for
--     the main wallet.
--   * window_start/window_end are returned so the UI states the real range
--     instead of implying one.
--   * observation_start is returned because our snapshot history begins
--     2026-06-09 while the wallet already held 52,118 moments on 2026-05-06 --
--     "all-time" here means "since we started watching", and a surface that
--     says otherwise is lying.
--
-- Reads the daily MV (~19.6k rows), never the 205k base table.
-- Revert: DROP FUNCTION IF EXISTS public.rpc_topshot_buyback_analytics(text, int);
CREATE OR REPLACE FUNCTION public.rpc_topshot_buyback_analytics(
  p_period text DEFAULT 'month',
  p_limit  int  DEFAULT 10
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today   date := (now() AT TIME ZONE 'UTC')::date;
  v_start   date;
  v_obs     date;
  v_limit   int  := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_result  jsonb;
BEGIN
  -- Reject an unknown period rather than defaulting: silently substituting a
  -- window renders the wrong range under the right label.
  IF p_period IS NULL OR p_period NOT IN ('week', 'month', 'year', 'all') THEN
    RAISE EXCEPTION 'invalid period %, expected week|month|year|all', p_period
      USING ERRCODE = '22023';
  END IF;

  SELECT min(d.activity_date) INTO v_obs
  FROM public.topshot_buyback_daily d
  JOIN public.seeded_wallets sw
    ON lower(sw.wallet_address) = lower(d.buyer_address)
   AND 'secondary_buyback' = ANY(sw.tags);

  v_start := CASE p_period
    WHEN 'week'  THEN date_trunc('week',  v_today)::date
    WHEN 'month' THEN date_trunc('month', v_today)::date
    WHEN 'year'  THEN date_trunc('year',  v_today)::date
    ELSE v_obs
  END;

  WITH scope AS (
    SELECT d.*, sw.username
    FROM public.topshot_buyback_daily d
    JOIN public.seeded_wallets sw
      ON lower(sw.wallet_address) = lower(d.buyer_address)
     AND 'secondary_buyback' = ANY(sw.tags)
    WHERE d.activity_date >= v_start
      AND d.activity_date <= v_today
  ),
  totals AS (
    SELECT
      coalesce(sum(acquisitions), 0)::bigint        AS acquisitions,
      coalesce(sum(priced_acquisitions), 0)::bigint AS priced_acquisitions,
      coalesce(sum(spend_usd), 0)::numeric          AS spend_usd,
      count(DISTINCT edition_id)                    AS distinct_editions,
      count(DISTINCT activity_date)                 AS active_days
    FROM scope
  ),
  by_wallet AS (
    SELECT jsonb_agg(w ORDER BY w.acquisitions DESC) AS j
    FROM (
      SELECT
        s.buyer_address                                  AS address,
        max(s.username)                                  AS username,
        sum(s.acquisitions)::bigint                      AS acquisitions,
        sum(s.priced_acquisitions)::bigint               AS priced_acquisitions,
        sum(s.spend_usd)                                 AS spend_usd,
        count(DISTINCT s.edition_id)                     AS distinct_editions,
        -- spend is only a real figure when something in scope carried a price
        (sum(s.priced_acquisitions) > 0)                 AS spend_known
      FROM scope s GROUP BY s.buyer_address
    ) w
  ),
  top_ed_count AS (
    SELECT jsonb_agg(e ORDER BY e.acquisitions DESC) AS j
    FROM (
      SELECT
        s.edition_id,
        max(ed.player_name)                AS player_name,
        max(ed.set_name)                   AS set_name,
        max(ed.tier::text)                 AS tier,
        max(ed.series)                     AS series,
        sum(s.acquisitions)::bigint        AS acquisitions,
        sum(s.priced_acquisitions)::bigint AS priced_acquisitions,
        sum(s.spend_usd)                   AS spend_usd
      FROM scope s
      JOIN public.editions ed ON ed.id = s.edition_id
      WHERE s.edition_id IS NOT NULL
      GROUP BY s.edition_id
      ORDER BY sum(s.acquisitions) DESC
      LIMIT v_limit
    ) e
  ),
  top_ed_spend AS (
    SELECT jsonb_agg(e ORDER BY e.spend_usd DESC) AS j
    FROM (
      SELECT
        s.edition_id,
        max(ed.player_name)                AS player_name,
        max(ed.set_name)                   AS set_name,
        max(ed.tier::text)                 AS tier,
        sum(s.priced_acquisitions)::bigint AS priced_acquisitions,
        sum(s.spend_usd)                   AS spend_usd
      FROM scope s
      JOIN public.editions ed ON ed.id = s.edition_id
      WHERE s.edition_id IS NOT NULL AND s.priced_acquisitions > 0
      GROUP BY s.edition_id
      ORDER BY sum(s.spend_usd) DESC NULLS LAST
      LIMIT v_limit
    ) e
  ),
  -- Sellers exist ONLY on priced marketplace rows. Both leaderboards are built
  -- from that subset and the caller is told how big it is.
  sellers AS (
    SELECT
      s.seller_address,
      max(u.username)                    AS username,
      sum(s.priced_acquisitions)::bigint AS purchases,
      sum(s.spend_usd)                   AS spend_usd
    FROM scope s
    LEFT JOIN public.wallet_usernames u
      ON lower(u.wallet_addr) = lower(s.seller_address)
    WHERE s.seller_address IS NOT NULL AND s.priced_acquisitions > 0
    GROUP BY s.seller_address
  ),
  top_sell_spend AS (
    SELECT jsonb_agg(x ORDER BY x.spend_usd DESC) AS j
    FROM (SELECT * FROM sellers ORDER BY spend_usd DESC NULLS LAST LIMIT v_limit) x
  ),
  top_sell_count AS (
    SELECT jsonb_agg(x ORDER BY x.purchases DESC) AS j
    FROM (SELECT * FROM sellers ORDER BY purchases DESC LIMIT v_limit) x
  ),
  timeline AS (
    SELECT jsonb_agg(t ORDER BY t.d) AS j
    FROM (
      SELECT
        s.activity_date                    AS d,
        sum(s.acquisitions)::bigint        AS acquisitions,
        sum(s.priced_acquisitions)::bigint AS priced_acquisitions,
        sum(s.spend_usd)                   AS spend_usd
      FROM scope s GROUP BY s.activity_date
    ) t
  )
  SELECT jsonb_build_object(
    'period',        p_period,
    'window_start',  v_start,
    'window_end',    v_today,
    'totals', jsonb_build_object(
      'acquisitions',        t.acquisitions,
      'priced_acquisitions', t.priced_acquisitions,
      'spend_usd',           t.spend_usd,
      'spend_known',         (t.priced_acquisitions > 0),
      'distinct_editions',   t.distinct_editions,
      'active_days',         t.active_days
    ),
    'coverage', jsonb_build_object(
      'observation_start',      v_obs,
      'unpriced_acquisitions',  t.acquisitions - t.priced_acquisitions,
      'unpriced_share_pct',     CASE WHEN t.acquisitions > 0
                                  THEN round(100.0 * (t.acquisitions - t.priced_acquisitions)
                                             / t.acquisitions, 1)
                                  ELSE NULL END,
      'counterparty_known_for', t.priced_acquisitions,
      'date_grain',             'day'
    ),
    'wallets',                coalesce(bw.j, '[]'::jsonb),
    'top_editions_by_count',  coalesce(tec.j, '[]'::jsonb),
    'top_editions_by_spend',  coalesce(tes.j, '[]'::jsonb),
    'top_sellers_by_spend',   coalesce(tss.j, '[]'::jsonb),
    'top_sellers_by_count',   coalesce(tsc.j, '[]'::jsonb),
    'timeline',               coalesce(tl.j,  '[]'::jsonb)
  )
  INTO v_result
  FROM totals t, by_wallet bw, top_ed_count tec, top_ed_spend tes,
       top_sell_spend tss, top_sell_count tsc, timeline tl;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_topshot_buyback_analytics(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_topshot_buyback_analytics(text, int) TO service_role;
