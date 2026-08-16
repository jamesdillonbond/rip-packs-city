-- Restrict buyback analytics to the VERIFIED arm, and disclose why.
--
-- WHY (measured 2026-08-16, live). The direct_transfer arm of
-- topshot_insider_buybacks records essentially ZERO real acquisitions. It is
-- produced by compute_institutional_wallet_diff comparing consecutive
-- wallet_holdings_snapshot rows, and that walk is unstable, so the wallet's own
-- existing stock drops out of one snapshot and reappears in the next -- which
-- the diff reads as an arrival. Four independent measurements:
--
--   1. 0 of 200 sampled direct_transfer moments appear in `sales` at ANY time.
--      Positive control: 208 of 208 marketplace rows DO resolve on the same
--      join key, so the key is right and the absence is real.
--   2. 161,366 rows cover only 41,307 distinct moments (3.91 rows each).
--   3. Across nine consecutive day-triples, 62-86% of "arrivals" were already
--      in the wallet TWO DAYS EARLIER (present -> absent -> present), which no
--      real acquisition can do. That is a LOWER bound: it only catches 2-day
--      gaps.
--   4. Decisive: of the 41,307 distinct moments recorded as acquired,
--      41,301 (99.99%) were ALREADY HELD on the first snapshot (2026-05-19).
--      Only SIX were ever genuinely new.
--
-- Holdings corroborate: the wallet sits flat at ~52,120 (deltas 0, +/-1, +/-4)
-- while the table claimed ~6,500 acquisitions a day. The snapshot array is also
-- 13.6% duplicates (52,123 entries, 45,059 distinct), so moment_count itself
-- overstates the real holding -- further evidence the walk is unreliable.
--
-- So "what is the buyback wallet accumulating" is NOT answerable from this
-- table today, and the previous version of this function published a headline
-- of 161,797 acquisitions whose true value is ~6. The marketplace arm is
-- unaffected: every one of those rows carries a sale_id from the sales_2026
-- trigger and was independently confirmed against `sales`.
--
-- The artifact rows are COUNTED AND DISCLOSED rather than silently dropped, so
-- the surface can say why the number is small instead of implying the buyback
-- programme is inactive.
--
-- Revert: re-apply 20260816184646_audit_20260816_rpc_topshot_buyback_analytics.sql
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
  IF p_period IS NULL OR p_period NOT IN ('week', 'month', 'year', 'all') THEN
    RAISE EXCEPTION 'invalid period %, expected week|month|year|all', p_period
      USING ERRCODE = '22023';
  END IF;

  -- Observation start is the first VERIFIED purchase, not the first snapshot:
  -- the snapshot history is what we no longer trust.
  SELECT min(d.activity_date) INTO v_obs
  FROM public.topshot_buyback_daily d
  JOIN public.seeded_wallets sw
    ON lower(sw.wallet_address) = lower(d.buyer_address)
   AND 'secondary_buyback' = ANY(sw.tags)
  WHERE d.acquisition_method = 'marketplace';

  v_start := CASE p_period
    WHEN 'week'  THEN date_trunc('week',  v_today)::date
    WHEN 'month' THEN date_trunc('month', v_today)::date
    WHEN 'year'  THEN date_trunc('year',  v_today)::date
    ELSE v_obs
  END;

  WITH in_window AS (
    SELECT d.*, sw.username
    FROM public.topshot_buyback_daily d
    JOIN public.seeded_wallets sw
      ON lower(sw.wallet_address) = lower(d.buyer_address)
     AND 'secondary_buyback' = ANY(sw.tags)
    WHERE d.activity_date >= v_start
      AND d.activity_date <= v_today
  ),
  -- The ONLY arm we publish as fact.
  scope AS (
    SELECT * FROM in_window WHERE acquisition_method = 'marketplace'
  ),
  excluded AS (
    SELECT
      coalesce(sum(acquisitions), 0)::bigint AS rows_excluded,
      count(DISTINCT buyer_address)          AS wallets_affected
    FROM in_window WHERE acquisition_method <> 'marketplace'
  ),
  totals AS (
    SELECT
      coalesce(sum(acquisitions), 0)::bigint        AS purchases,
      coalesce(sum(priced_acquisitions), 0)::bigint AS priced_purchases,
      coalesce(sum(spend_usd), 0)::numeric          AS spend_usd,
      count(DISTINCT edition_id)                    AS distinct_editions,
      count(DISTINCT activity_date)                 AS active_days
    FROM scope
  ),
  by_wallet AS (
    SELECT jsonb_agg(w ORDER BY w.purchases DESC) AS j
    FROM (
      SELECT
        s.buyer_address                    AS address,
        max(s.username)                    AS username,
        sum(s.acquisitions)::bigint        AS purchases,
        sum(s.priced_acquisitions)::bigint AS priced_acquisitions,
        sum(s.spend_usd)                   AS spend_usd,
        count(DISTINCT s.edition_id)       AS distinct_editions,
        (sum(s.priced_acquisitions) > 0)   AS spend_known
      FROM scope s GROUP BY s.buyer_address
    ) w
  ),
  top_ed_count AS (
    SELECT jsonb_agg(e ORDER BY e.purchases DESC) AS j
    FROM (
      SELECT
        s.edition_id,
        max(ed.player_name)                AS player_name,
        max(ed.set_name)                   AS set_name,
        max(ed.tier::text)                 AS tier,
        max(ed.series)                     AS series,
        sum(s.acquisitions)::bigint        AS purchases,
        sum(s.priced_acquisitions)::bigint AS priced_acquisitions,
        sum(s.spend_usd)                   AS spend_usd
      FROM scope s
      JOIN public.editions ed ON ed.id = s.edition_id
      WHERE s.edition_id IS NOT NULL
      GROUP BY s.edition_id
      ORDER BY sum(s.acquisitions) DESC, sum(s.spend_usd) DESC NULLS LAST
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
        sum(s.acquisitions)::bigint        AS purchases,
        sum(s.priced_acquisitions)::bigint AS priced_acquisitions,
        sum(s.spend_usd)                   AS spend_usd
      FROM scope s GROUP BY s.activity_date
    ) t
  )
  SELECT jsonb_build_object(
    'period',        p_period,
    'window_start',  v_start,
    'window_end',    v_today,
    'basis',         'verified_marketplace_purchases',
    'totals', jsonb_build_object(
      'purchases',           t.purchases,
      'priced_purchases',    t.priced_purchases,
      'spend_usd',           t.spend_usd,
      'spend_known',         (t.priced_purchases > 0),
      'distinct_editions',   t.distinct_editions,
      'active_days',         t.active_days
    ),
    'coverage', jsonb_build_object(
      'observation_start',        v_obs,
      'unpriced_purchases',       t.purchases - t.priced_purchases,
      'counterparty_known_for',   t.priced_purchases,
      'date_grain',               'day',
      -- Disclose the excluded arm rather than silently dropping it.
      'excluded_snapshot_rows',   x.rows_excluded,
      'excluded_wallets',         x.wallets_affected,
      'excluded_reason',
        'Holdings-snapshot movements are excluded: the wallet walk is unstable, so '
        'the same moment leaves and re-enters the snapshot repeatedly. Measured '
        '2026-08-16, 41,301 of 41,307 distinct moments it reported as acquired were '
        'already held on the first snapshot, and 62-86% of daily arrivals were present '
        'two days earlier. Only verified marketplace purchases are counted here.'
    ),
    'wallets',                coalesce(bw.j, '[]'::jsonb),
    'top_editions_by_count',  coalesce(tec.j, '[]'::jsonb),
    'top_editions_by_spend',  coalesce(tes.j, '[]'::jsonb),
    'top_sellers_by_spend',   coalesce(tss.j, '[]'::jsonb),
    'top_sellers_by_count',   coalesce(tsc.j, '[]'::jsonb),
    'timeline',               coalesce(tl.j,  '[]'::jsonb)
  )
  INTO v_result
  FROM totals t, excluded x, by_wallet bw, top_ed_count tec, top_ed_spend tes,
       top_sell_spend tss, top_sell_count tsc, timeline tl;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.rpc_topshot_buyback_analytics(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_topshot_buyback_analytics(text, int) TO service_role;
