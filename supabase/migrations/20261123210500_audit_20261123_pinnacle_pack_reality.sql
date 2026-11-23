-- audit_20261123: Disney Pinnacle PACK REALITY — "did the packs pay?" per Pinnacle drop
-- (2026-11-23, Pinnacle ↔ Top Shot / All Day parity; Trevor: "look for any feature parity that we
-- don't have setup on pinnacle").
--
-- The collection roadmap (10-19) deferred a cross-drop Pinnacle board until ~10 drops had been valued
-- AT OPEN: `pinnacle_pack_opens.pull_value_usd` for opens before 2026-09 is the FMV on the BACKFILL
-- date (40–1,010 days late), so comparing an old pack's 2026 pulls to its retail price would mislead.
-- Read 11-23: 11 real drops opened since 2026-09-25, every one priced — the trigger is met.
--
-- Per DROP (a buyer's purchasable pack), not per sub-pool: Studio splits a "<X> Standard" product into
-- sub-distributions ("… Standard - Limited Standard / - Limited Chase / - Genesis") that share one
-- price and that a buyer cannot choose (#157) — the same title rule as v_pinnacle_pack_drop_ev.
-- Every open counts once (the realized average is what a random opened pack delivered).
--
-- Two values per opened pack, both from RPC's own render-grain FMV, never confidence (internal):
--   value_at_open — pull_value_usd, the first price RPC put on the pulls; counted only when it was
--                   written within 3 days of the open (else that pack's "at open" is unknown, not 0);
--   value_today   — Σ current pinnacle_catalog.fmv_usd of the pulled pins (nft_id → render_id via
--                   pinnacle_mint_events); a pack with ANY unpriced pin is left out, never summed as 0.
-- pct_today_at_or_above_price = share of those packs whose pulls are worth ≥ the retail price today.
--
-- Excluded: issuer-labelled non-products ("[OLD] …", "Internal Test", "Distribution Mock Test" — the
-- 11-06 sitemap rule), and dist 8922 "Walt Disney Mugs Vol.1 - … Friends-Giving Vol.2 LE": its 98
-- opens are only the LE-pin capsules of a $9.99 mug capsule sale whose other capsules minted open-
-- edition mugs outside any pack open, so its "packs" are a chase-only subset and would read as a
-- guaranteed 4× pack. A drop needs ≥ 25 opens.
--
-- Measured 11-23 ~12:55 PM PT (the read this function reproduces): Summer Sunset Premium $99.99 →
-- today avg $212.97, 92 % at/above price; Star Wars Halloween $49.95 → $39.83, 11 %; Stitch in
-- Costume $49.95 → avg $125.07 but median $26.00, 28 %. ~1.2 s cold; the page is ISR (1 h).
--
-- Served by the page's and the public route's service-role read; anon/authenticated cannot execute.
-- Revert: DROP FUNCTION public.get_pinnacle_pack_reality(timestamptz, integer);

-- anon-exec: revoked (get_pinnacle_pack_reality) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_pinnacle_pack_reality(
  p_since timestamptz DEFAULT '2026-09-01 00:00:00-07',
  p_min_opens integer DEFAULT 25
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH d AS (
    SELECT pd.dist_id::text AS dist_id,
           pd.title,
           NULLIF((pd.metadata ->> 'retail_price_usd')::numeric, 0) AS price_usd,
           COALESCE((regexp_match(pd.title, '^(.*Standard) - (.+)$'))[1], pd.title) AS drop_name
      FROM public.pack_distributions pd
     WHERE pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
       AND pd.title IS NOT NULL
       AND pd.title !~ '^\[OLD\]'
       AND pd.title NOT IN ('Internal Test', 'Distribution Mock Test')
       AND pd.dist_id::text <> '8922'
  ), o AS (
    SELECT o.pack_nft_id, o.dist_id, o.opened_at,
           CASE WHEN o.priced_at IS NOT NULL AND o.priced_at <= o.opened_at + interval '3 days'
                THEN o.pull_value_usd END AS value_at_open,
           o.nft_ids
      FROM public.pinnacle_pack_opens o
     WHERE o.opened_at >= p_since
       AND o.dist_id IN (SELECT dist_id FROM d)
  ), pulls AS (
    SELECT o.pack_nft_id, count(*) AS n, count(pc.fmv_usd) FILTER (WHERE pc.fmv_usd > 0) AS n_priced,
           sum(pc.fmv_usd) FILTER (WHERE pc.fmv_usd > 0) AS value_today
      FROM o
      CROSS JOIN LATERAL unnest(o.nft_ids) u(nft)
      LEFT JOIN public.pinnacle_mint_events me ON me.nft_id::text = u.nft
      LEFT JOIN public.pinnacle_catalog pc ON pc.render_id = me.render_id
     GROUP BY o.pack_nft_id
  ), per_pack AS (
    SELECT d.drop_name, d.price_usd, d.dist_id, o.opened_at, o.value_at_open,
           CASE WHEN p.n > 0 AND p.n = p.n_priced THEN p.value_today END AS value_today
      FROM o
      JOIN d ON d.dist_id = o.dist_id
      LEFT JOIN pulls p ON p.pack_nft_id = o.pack_nft_id
  ), drops AS (
    SELECT drop_name, price_usd,
           array_agg(DISTINCT dist_id ORDER BY dist_id)                    AS dist_ids,
           count(*)::int                                                   AS packs_opened,
           min(opened_at)                                                  AS first_open_at,
           max(opened_at)                                                  AS last_open_at,
           count(value_at_open)::int                                       AS n_at_open,
           round(avg(value_at_open), 2)                                    AS avg_value_at_open,
           count(value_today)::int                                         AS n_today,
           round(avg(value_today), 2)                                      AS avg_value_today,
           round((percentile_cont(0.5) WITHIN GROUP (ORDER BY value_today))::numeric, 2) AS median_value_today,
           round(max(value_today), 2)                                      AS best_pull_today,
           CASE WHEN price_usd IS NULL OR count(value_today) = 0 THEN NULL
                ELSE round(100.0 * count(*) FILTER (WHERE value_today >= price_usd) / count(value_today), 1)
           END                                                             AS pct_today_at_or_above_price
      FROM per_pack
     GROUP BY drop_name, price_usd
    HAVING count(*) >= GREATEST(COALESCE(p_min_opens, 25), 1)
  )
  SELECT jsonb_build_object(
    'since', p_since,
    'min_opens', GREATEST(COALESCE(p_min_opens, 25), 1),
    'drops', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'drop_name', drop_name, 'price_usd', price_usd, 'dist_ids', to_jsonb(dist_ids),
               'packs_opened', packs_opened, 'first_open_at', first_open_at, 'last_open_at', last_open_at,
               'n_at_open', n_at_open, 'avg_value_at_open', avg_value_at_open,
               'n_today', n_today, 'avg_value_today', avg_value_today,
               'median_value_today', median_value_today, 'best_pull_today', best_pull_today,
               'pct_today_at_or_above_price', pct_today_at_or_above_price)
             ORDER BY first_open_at DESC, drop_name)
        FROM drops), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_pack_reality(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_pack_reality(timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.get_pinnacle_pack_reality(timestamptz, integer) IS
  'Disney Pinnacle Pack Reality (2026-11-23): per purchasable drop opened since p_since (default 2026-09-01 PT, the first drops valued at open), retail price vs the pulls'' value at open (first price within 3 days) and today (current render FMV; packs with any unpriced pin left out), and the share of packs worth >= price today. Sub-pools of one "<X> Standard" product grouped (#157); non-products and the chase-only dist 8922 excluded; >= p_min_opens opens.';
