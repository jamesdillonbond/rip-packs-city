-- audit_20261110_withdrawn_prices_in_wallets_count_as_stale
--
-- WHY (inbox 2026-11-10T1800Z, Cowork audit; Trevor: "Do what you think is best" -> keep the
-- last price, show it as stale). An edition whose price the engine WITHDREW has a current row
-- with a NULL price (newest snapshot `cold-tail-1.0` / NO_DATA). Every wmc writer keeps the
-- last NON-NULL price, so the moment stays priced in the cache — and the five wallet readers
-- counted it in the HEADLINE: its current label is NO_DATA, not STALE. Measured 11-10 ~10 AM PT:
-- 492 cached moments / $93,507 (All Day 444 / $70,508 in 48 wallets; Top Shot 48 / $22,999 in
-- 33). One collector's headline carried $16,560 of withdrawn prices (~a fifth of it).
--
-- RULE (each reader, written inline so it plans like the rest of the body): a moment whose
-- edition has a current price row with a NULL price, and whose cached price is NOT NULL, is
-- STALE — it keeps its price and moves from the headline to the stale line. A moment that
-- never had a price (cached NULL) is not made stale. The total is unchanged everywhere.
--   get_wallet_summary              /api/wallet-summary (Collection tab)
--   get_wallet_collection_stats     dashboard per-collection stats (newest snapshot)
--   get_wallet_collection_snapshot  /api/collection-snapshot (share card, front door)
--   get_collection_breakdown        profile collection breakdown
--   aggregate_saved_wallet_stats    saved_wallets cached totals
-- All five change in ONE migration so no two surfaces disagree about one wallet.
--
-- anon-exec: unchanged (get_wallet_summary) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=true (the route reads it).
-- anon-exec: unchanged (get_collection_breakdown) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=true.
-- anon-exec: unchanged (aggregate_saved_wallet_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false, authenticated=false.
-- anon-exec: unchanged (get_wallet_collection_stats) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false, authenticated=false.
-- anon-exec: unchanged (get_wallet_collection_snapshot) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false, authenticated=false.
--
-- REVERT: re-apply the previous bodies — get_wallet_summary from 20261110151338,
-- get_collection_breakdown from 20260903142035, aggregate_saved_wallet_stats from
-- 20260903023012, get_wallet_collection_snapshot from 20261104042335, and
-- get_wallet_collection_stats as it stood before this file (prosrc md5 5cc5e0ec…; the
-- 20260806020844 body plus the 10-19 Panini exclusion `AND c.slug <> 'panini_blockchain'`).

CREATE OR REPLACE FUNCTION public.get_wallet_summary(p_wallet text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH moment_data AS (
    SELECT
      wmc.moment_id,
      wmc.is_locked,
      (wmc.lock_checked_at IS NOT NULL) AS lock_known,
      -- 2026-09-25: fall back to the cache's own FMV like get_wallet_total_fmv
      -- does — Pinnacle resolves 0 rows through edition_fmv_current.
      COALESCE(lf.fmv_usd, wmc.fmv_usd) AS fmv_usd,
      -- 2026-11-10: a price the engine WITHDREW (a current row whose price is NULL) is kept at
      -- the last cached value above and labelled STALE, so it leaves the headline for the
      -- stale line. A moment that never had a price (cached NULL) is not made stale.
      CASE WHEN lf.edition_id IS NOT NULL AND lf.fmv_usd IS NULL AND wmc.fmv_usd IS NOT NULL
           THEN 'STALE'::fmv_confidence
           ELSE COALESCE(lf.confidence, wmc.fmv_confidence) END AS confidence,
      ma.buy_price,
      ma.acquisition_method
    FROM wallet_moments_cache wmc
    LEFT JOIN editions e ON e.external_id = wmc.edition_key AND e.collection_id = p_collection_id
    -- 2026-09-06: latest-per-edition lives in edition_fmv_current (202K buffers → index probes)
    LEFT JOIN edition_fmv_current lf ON lf.edition_id = e.id
    LEFT JOIN LATERAL (
      SELECT ma2.buy_price, ma2.acquisition_method
      FROM moment_acquisitions ma2
      WHERE ma2.nft_id = wmc.moment_id AND ma2.wallet = wmc.wallet_address
        -- 2026-11-10: a moment_id is unique only WITHIN a collection (#142/#223) — scope the cost basis
        AND ma2.collection_id = wmc.collection_id
      ORDER BY ma2.created_at DESC LIMIT 1
    ) ma ON true
    WHERE wmc.wallet_address = p_wallet AND wmc.collection_id = p_collection_id
  )
  SELECT json_build_object(
    'total_moments', (SELECT COUNT(*) FROM moment_data),
    'wallet_fmv', (SELECT ROUND(COALESCE(SUM(fmv_usd), 0)::numeric, 2) FROM moment_data),
    'unlocked_fmv', (SELECT ROUND(COALESCE(SUM(CASE WHEN lock_known AND NOT is_locked THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),
    'locked_fmv', (SELECT ROUND(COALESCE(SUM(CASE WHEN is_locked THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),
    -- 2026-09-06: the stale split, so the Collection tab can headline total − stale like every other surface
    'stale_fmv', (SELECT ROUND(COALESCE(SUM(CASE WHEN confidence = 'STALE' THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),
    'stale_count', (SELECT COUNT(*) FROM moment_data WHERE confidence = 'STALE'),
    'locked_count', (SELECT COUNT(*) FROM moment_data WHERE is_locked),
    'unlocked_count', (SELECT COUNT(*) FROM moment_data WHERE lock_known AND NOT is_locked),
    'lock_unknown_fmv', (SELECT ROUND(COALESCE(SUM(CASE WHEN NOT lock_known THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),
    'lock_unknown_count', (SELECT COUNT(*) FROM moment_data WHERE NOT lock_known),
    'cost_basis', (SELECT ROUND(COALESCE(SUM(buy_price), 0)::numeric, 2) FROM moment_data WHERE buy_price IS NOT NULL),
    'current_fmv', (SELECT ROUND(COALESCE(SUM(fmv_usd), 0)::numeric, 2) FROM moment_data WHERE buy_price IS NOT NULL),
    'pnl', (SELECT ROUND(
      COALESCE(SUM(fmv_usd), 0) - COALESCE(SUM(buy_price), 0), 2
    )::numeric FROM moment_data WHERE buy_price IS NOT NULL),
    'moments_with_cost', (SELECT COUNT(*) FROM moment_data WHERE buy_price IS NOT NULL),
    'acquisition_breakdown', (
      SELECT json_agg(json_build_object(
        'method', acquisition_method, 'count', cnt, 'total_spent', spent
      ) ORDER BY cnt DESC)
      FROM (
        SELECT acquisition_method, COUNT(*) AS cnt, 
          ROUND(SUM(COALESCE(buy_price, 0))::numeric, 2) AS spent
        FROM moment_data
        WHERE acquisition_method IS NOT NULL
        GROUP BY acquisition_method
      ) sub
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.get_wallet_collection_stats(p_wallet_addr text)
 RETURNS TABLE(collection_id uuid, collection_slug text, collection_label text, moment_count bigint, fmv_total numeric, fmv_stale_total numeric, stale_count bigint, fmv_max numeric, priced_count bigint, locked_count bigint, top_tier text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
  WITH holdings AS MATERIALIZED (
    SELECT
      wmc.collection_id AS coll_id,
      wmc.fmv_usd,
      wmc.is_locked,
      wmc.tier,
      e.id AS edition_id
    FROM wallet_moments_cache wmc
    LEFT JOIN editions e
      ON e.external_id = wmc.edition_key
     AND e.collection_id = wmc.collection_id
    WHERE wmc.wallet_address = p_wallet_addr
  ),
  held_editions AS MATERIALIZED (
    SELECT DISTINCT edition_id FROM holdings WHERE edition_id IS NOT NULL
  ),
  conf AS MATERIALIZED (
    SELECT he.edition_id, f.confidence,
           -- 2026-11-10: a WITHDRAWN price (newest snapshot NULL) still cached is stale too.
           (f.fmv_usd IS NULL) AS withdrawn
    FROM held_editions he
    CROSS JOIN LATERAL (
      SELECT s.confidence, s.fmv_usd
      FROM fmv_snapshots s
      WHERE s.edition_id = he.edition_id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) f
  ),
  top_tiers AS (
    SELECT DISTINCT ON (h.coll_id) h.coll_id, h.tier
    FROM holdings h
    WHERE h.tier IS NOT NULL
    ORDER BY
      h.coll_id,
      CASE h.tier
        WHEN 'ULTIMATE'  THEN 5
        WHEN 'LEGENDARY' THEN 4
        WHEN 'RARE'      THEN 3
        WHEN 'FANDOM'    THEN 2
        WHEN 'COMMON'    THEN 1
        ELSE 0
      END DESC,
      h.fmv_usd DESC NULLS LAST
  )
  SELECT
    c.id AS collection_id,
    c.slug::TEXT AS collection_slug,
    c.name::TEXT AS collection_label,
    COUNT(h.*) AS moment_count,
    COALESCE(ROUND(SUM(h.fmv_usd) FILTER (WHERE NOT (cf.confidence IS NOT DISTINCT FROM 'STALE' OR (cf.withdrawn IS TRUE AND h.fmv_usd IS NOT NULL)))::numeric, 2), 0) AS fmv_total,
    COALESCE(ROUND(SUM(h.fmv_usd) FILTER (WHERE cf.confidence IS NOT DISTINCT FROM 'STALE' OR (cf.withdrawn IS TRUE AND h.fmv_usd IS NOT NULL))::numeric, 2), 0) AS fmv_stale_total,
    COUNT(h.*) FILTER (WHERE cf.confidence IS NOT DISTINCT FROM 'STALE' OR (cf.withdrawn IS TRUE AND h.fmv_usd IS NOT NULL)) AS stale_count,
    COALESCE(ROUND(MAX(h.fmv_usd)::numeric, 2), 0) AS fmv_max,
    COUNT(h.*) FILTER (WHERE h.fmv_usd IS NOT NULL) AS priced_count,
    COUNT(h.*) FILTER (WHERE h.is_locked = TRUE) AS locked_count,
    (SELECT tt.tier FROM top_tiers tt WHERE tt.coll_id = c.id) AS top_tier
  FROM collections c
  LEFT JOIN holdings h
    ON h.coll_id = c.id
  LEFT JOIN conf cf
    ON cf.edition_id = h.edition_id
  WHERE c.is_active = TRUE
    -- #64 (2026-10-19): an ADDRESS cannot hold a Panini card (owners are usernames,
    -- saved_collector_identities); a Panini row here could only ever read 0 / $0.
    AND c.slug <> 'panini_blockchain'
  GROUP BY c.id, c.slug, c.name
  ORDER BY fmv_total DESC NULLS LAST, moment_count DESC NULLS LAST;
$function$;

CREATE OR REPLACE FUNCTION public.get_wallet_collection_snapshot(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  -- 2026-10-02: dynamic SQL on purpose. EXECUTE … USING plans the statement with the
  -- wallet's REAL row estimate, so an 18k-moment wallet gets hash joins where the
  -- SQL-language body's generic plan gave it per-row nested loops (744k buffers).
  -- 2026-11-03 (#228): `w` reads ONLY columns carried by the wallet covering index
  -- (wallet_address, collection_id, edition_key) INCLUDE (fmv_usd, tier, series_number,
  -- mint_count), so every aggregate is an index-only scan. The wide display columns
  -- (names, image, serial) are read from the heap for the top-5 / rarest EDITIONS only.
  -- The largest wallet's rows sit on ~47k heap pages: 11.3 s cold, 8 s route timeout.
  EXECUTE $q$
  WITH w AS (
    SELECT collection_id, edition_key, fmv_usd, series_number, mint_count
    FROM wallet_moments_cache
    WHERE wallet_address = $1
  ),
  -- The top 5 moments by FMV all belong to the top 5 editions by max FMV (an edition
  -- outside them has a max no higher than the 5th moment), so only those editions'
  -- rows are fetched for display.
  top_keys AS (
    SELECT collection_id, edition_key
    FROM w
    WHERE fmv_usd IS NOT NULL AND fmv_usd > 0
    GROUP BY collection_id, edition_key
    ORDER BY max(fmv_usd) DESC
    LIMIT 5
  ),
  top5 AS (
    SELECT jsonb_agg(t) AS arr FROM (
      SELECT m.player_name AS "playerName",
             m.set_name    AS "setName",
             m.tier,
             m.serial_number AS serial,
             round(COALESCE(m.fmv_usd, 0)::numeric, 2) AS fmv,
             m.image_url   AS "thumbnailUrl"
      FROM (
        -- Two arms, not one OR: an OR on edition_key drops collection_id from the
        -- index condition and probes the whole wallet's index range per key.
        SELECT m.player_name, m.set_name, m.tier, m.serial_number, m.fmv_usd, m.image_url
        FROM top_keys k
        JOIN wallet_moments_cache m
          ON m.wallet_address = $1 AND m.collection_id = k.collection_id AND m.edition_key = k.edition_key
        UNION ALL
        SELECT m.player_name, m.set_name, m.tier, m.serial_number, m.fmv_usd, m.image_url
        FROM top_keys k
        JOIN wallet_moments_cache m
          ON m.wallet_address = $1 AND m.collection_id = k.collection_id AND m.edition_key IS NULL
        WHERE k.edition_key IS NULL
      ) m
      WHERE m.fmv_usd IS NOT NULL AND m.fmv_usd > 0
      ORDER BY m.fmv_usd DESC
      LIMIT 5
    ) t
  ),
  -- 2026-09-24: the bars are the wallet's LARGEST collection's series, named
  -- the way every other page names them (series_display_label). Mixing every
  -- collection's raw series number into one row named nothing ("S0", "S9").
  series_coll AS (
    SELECT w.collection_id, c.slug, c.name
    FROM w JOIN collections c ON c.id = w.collection_id
    GROUP BY w.collection_id, c.slug, c.name
    ORDER BY count(*) DESC, c.slug
    LIMIT 1
  ),
  series_rows AS (
    -- 2026-09-25: grouped by LABEL — on-chain 0 and a stored 1 are both Top Shot
    -- "Series 1" and drew two bars.
    -- 2026-10-02: labelled per DISTINCT (collection, series_number), not per
    -- moment — series_display_label ran 38,666 times (77k buffers) on one wallet
    -- for 8 distinct values.
    SELECT min(d.series_number) AS series_number,
           COALESCE(public.series_display_label(d.collection_id, d.series_number::int), 'SUnknown') AS label,
           sum(d.cnt)::int AS cnt
    FROM (
      SELECT w.collection_id, w.series_number, count(*) AS cnt
      FROM w
      WHERE w.collection_id = (SELECT collection_id FROM series_coll)
      GROUP BY w.collection_id, w.series_number
    ) d
    GROUP BY d.collection_id, COALESCE(public.series_display_label(d.collection_id, d.series_number::int), 'SUnknown')
  ),
  series AS (
    SELECT jsonb_object_agg(label, cnt) AS obj FROM series_rows
  ),
  series_bars AS (
    SELECT jsonb_agg(jsonb_build_object('label', label, 'count', cnt, 'series_number', series_number)
                     ORDER BY series_number NULLS LAST) AS arr
    FROM series_rows
  ),
  badges AS (
    SELECT ((
      SELECT count(DISTINCT be.external_id)
      FROM badge_editions be
      WHERE be.external_id IN (SELECT DISTINCT edition_key FROM w WHERE edition_key IS NOT NULL)
    ) + (
      -- 2026-10-26: Candy MLB's designations (editions.badges 'Rookie' / 'First Mint', from Candy's
      -- checklist; the Rainbow colours are the parallel, not a designation). badge_editions holds no
      -- Candy rows, so a Candy card read "0 badges" beside 111 designated cards.
      SELECT count(DISTINCT e.external_id)
      FROM editions e
      WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
        AND e.badges && ARRAY['Rookie', 'First Mint']::text[]
        AND e.external_id IN (SELECT DISTINCT w.edition_key FROM w
                               WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ))::int AS c
  ),
  -- 2026-10-02: each held edition's CURRENT confidence, resolved ONCE per distinct
  -- (edition_key, collection) instead of a LATERAL probe per moment (58k buffers
  -- on one wallet). editions(external_id, collection_id) is unique, so this is the
  -- same row the LIMIT 1 probe returned.
  -- 2026-11-03 (#228 follow-up): only the STALE rows. Every reader below uses `conf` solely
  -- through `confidence = 'STALE'` (per_coll's FILTERs, stale's WHERE), and the key is unique,
  -- so the LEFT JOIN cannot multiply rows — dropping the non-STALE rows changes no output. It
  -- replaces a full `editions` scan plus one edition_fmv_current probe per held edition
  -- (11.5k probes, ~52k buffers on a 63k-moment wallet) with the ~3k STALE rows (~14k).
  -- 2026-11-10: and the rows whose price the engine WITHDREW (NULL price, ~1.8k): a moment
  -- still cached at its last price on such an edition is stale, not part of the headline.
  -- `withdrawn` is only read with w.fmv_usd IS NOT NULL (a never-priced moment stays out).
  conf AS (
    SELECT e.external_id AS edition_key, e.collection_id, l.confidence, (l.fmv_usd IS NULL) AS withdrawn
    FROM edition_fmv_current l
    JOIN editions e ON e.id = l.edition_id
    WHERE (l.confidence = 'STALE' OR l.fmv_usd IS NULL)
      AND (e.external_id, e.collection_id) IN (
        SELECT DISTINCT w.edition_key, w.collection_id FROM w WHERE w.edition_key IS NOT NULL
      )
  ),
  per_coll AS (
    SELECT jsonb_agg(pc ORDER BY (pc->>'moments')::int DESC) AS arr FROM (
      SELECT jsonb_build_object(
               'slug', c.slug,
               'name', c.name,
               'moments', count(*),
               -- Closed markets carry a count but no dollar total (a closed
               -- market has no current value). market_closed_at lets the UI
               -- render a "count + note" instead of a figure.
               'fmv', round(COALESCE(sum(w.fmv_usd), 0)::numeric, 2),
               -- 2026-09-06: same basis as the headline (total − stale). The card
               -- printed NBA Top Shot $87,785 raw beside a $50,223 headline.
               'stale_fmv', round(COALESCE(sum(w.fmv_usd) FILTER (WHERE l.confidence = 'STALE' OR (l.withdrawn AND w.fmv_usd IS NOT NULL)), 0)::numeric, 2),
               'stale_count', count(*) FILTER (WHERE l.confidence = 'STALE' OR (l.withdrawn AND w.fmv_usd IS NOT NULL)),
               'market_closed_at', c.market_closed_at
             ) AS pc
      FROM w JOIN collections c ON c.id = w.collection_id
      LEFT JOIN conf l ON l.edition_key = w.edition_key AND l.collection_id = w.collection_id
      GROUP BY c.slug, c.name, c.market_closed_at
    ) x
  ),
  -- 2026-09-04: stale split, so the front door can headline total − stale like the profile
  stale AS (
    SELECT
      round(COALESCE(sum(w.fmv_usd) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2) AS stale_fmv,
      -- 2026-09-25: the COUNT pairs with the AMOUNT — a closed market's STALE
      -- holdings are outside both, or the card says "$6,419 across 227" when
      -- 191 of the 227 are UFC moments whose dollars the figure excludes.
      count(*) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      )::int AS stale_count
    FROM w
    JOIN conf l ON l.edition_key = w.edition_key AND l.collection_id = w.collection_id
    WHERE (l.confidence = 'STALE' OR (l.withdrawn AND w.fmv_usd IS NOT NULL))
  ),
  -- The rarest moment's sort key (smallest positive mint, FMV-desc tiebreak) is read
  -- from `w`; its display row is then fetched from that one edition.
  rare_key AS (
    SELECT collection_id, edition_key, mint_count, fmv_usd
    FROM w
    WHERE mint_count IS NOT NULL AND mint_count > 0
    ORDER BY mint_count ASC, fmv_usd DESC NULLS LAST
    LIMIT 1
  ),
  rarest AS (
    SELECT to_jsonb(r) AS obj FROM (
      SELECT m.player_name AS "playerName",
             m.set_name    AS "setName",
             m.tier,
             m.serial_number AS serial,
             m.mint_count  AS "mintCount",
             round(COALESCE(m.fmv_usd, 0)::numeric, 2) AS fmv,
             m.image_url   AS "thumbnailUrl"
      FROM (
        SELECT m.player_name, m.set_name, m.tier, m.serial_number, m.mint_count, m.fmv_usd, m.image_url
        FROM rare_key k
        JOIN wallet_moments_cache m
          ON m.wallet_address = $1 AND m.collection_id = k.collection_id AND m.edition_key = k.edition_key
        WHERE m.mint_count = k.mint_count AND m.fmv_usd IS NOT DISTINCT FROM k.fmv_usd
        UNION ALL
        SELECT m.player_name, m.set_name, m.tier, m.serial_number, m.mint_count, m.fmv_usd, m.image_url
        FROM rare_key k
        JOIN wallet_moments_cache m
          ON m.wallet_address = $1 AND m.collection_id = k.collection_id AND m.edition_key IS NULL
        WHERE k.edition_key IS NULL
          AND m.mint_count = k.mint_count AND m.fmv_usd IS NOT DISTINCT FROM k.fmv_usd
      ) m
      LIMIT 1
    ) r
  )
  SELECT jsonb_build_object(
    'wallet', $1,
    'totalMoments', (SELECT count(*)::int FROM w),
    -- Grand FMV excludes collections whose market has closed; their moments
    -- still count in totalMoments (real holdings), but their dead-market value
    -- is not folded into the headline total.
    'totalFmv', round(COALESCE((
        SELECT sum(fmv_usd) FROM w
        WHERE collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2),
    'topMoments', COALESCE((SELECT arr FROM top5), '[]'::jsonb),
    'badgeCount', COALESCE((SELECT c FROM badges), 0),
    'seriesBreakdown', COALESCE((SELECT obj FROM series), '{}'::jsonb),
    'seriesBars', COALESCE((SELECT arr FROM series_bars), '[]'::jsonb),
    'seriesCollection', (SELECT jsonb_build_object('slug', slug, 'name', name) FROM series_coll),
    'perCollection', COALESCE((SELECT arr FROM per_coll), '[]'::jsonb),
    'rarest', (SELECT obj FROM rarest),
    'staleFmv', COALESCE((SELECT stale_fmv FROM stale), 0),
    'staleCount', COALESCE((SELECT stale_count FROM stale), 0)
  )
  $q$ INTO v USING p_wallet;
  RETURN v;
END
$function$;

CREATE OR REPLACE FUNCTION public.get_collection_breakdown(p_wallet text)
 RETURNS json
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(json_agg(row_to_json(t)), '[]'::json)
  from (
    select
      c.id::text  as collection_id,
      c.name      as collection_name,
      count(*)::int as moment_count,
      coalesce(sum(w.fmv_usd), 0)::numeric as total_fmv,
      -- Stale slice, read through editions → edition_fmv_current (the display
      -- source database.md sanctions; wmc.fmv_confidence is a lagging denorm).
      -- 2026-11-10: a WITHDRAWN price (current row, NULL price) still cached is stale too.
      coalesce(sum(w.fmv_usd) filter (where efc.confidence = 'STALE' or (efc.edition_id is not null and efc.fmv_usd is null and w.fmv_usd is not null)), 0)::numeric as stale_fmv,
      (count(*) filter (where efc.confidence = 'STALE' or (efc.edition_id is not null and efc.fmv_usd is null and w.fmv_usd is not null)))::int as stale_count
    from wallet_moments_cache w
    left join collections c on c.id = w.collection_id
    left join editions e
      on e.external_id = w.edition_key
     and e.collection_id = w.collection_id   -- external_id is only unique PER COLLECTION
    left join edition_fmv_current efc on efc.edition_id = e.id
    where w.wallet_address = lower(p_wallet)
    group by c.id, c.name
    order by total_fmv desc nulls last, moment_count desc
  ) t;
$function$;

CREATE OR REPLACE FUNCTION public.aggregate_saved_wallet_stats(p_user_id uuid, p_wallet_addr text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- AUTHZ: caller must be the user they claim to be (service_role bypasses)
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH agg AS (
    SELECT
      wmc.collection_id,
      COUNT(*) AS moment_count,
      COALESCE(SUM(wmc.fmv_usd), 0) AS fmv_sum,
      -- Stale split (2026-09-02): the same definition the dashboard's
      -- get_wallet_collection_stats uses — latest confidence per edition,
      -- read from the edition_fmv_current table rather than fmv_snapshots.
      -- 2026-11-10: a WITHDRAWN price (current row, NULL price) still cached is stale too.
      COALESCE(SUM(wmc.fmv_usd) FILTER (WHERE efc.confidence = 'STALE' OR (efc.edition_id IS NOT NULL AND efc.fmv_usd IS NULL AND wmc.fmv_usd IS NOT NULL)), 0) AS fmv_stale_sum,
      COUNT(*) FILTER (WHERE efc.confidence = 'STALE' OR (efc.edition_id IS NOT NULL AND efc.fmv_usd IS NULL AND wmc.fmv_usd IS NOT NULL)) AS stale_count,
      -- Same ordering key as the correlated subquery this replaces, evaluated
      -- in the scan the outer aggregate is ALREADY doing. The trailing
      -- UPPER(wmc.tier) is the new deterministic tiebreak for the ELSE 6 class.
      -- FILTER reproduces the old `t.tier IS NOT NULL`, and an all-NULL group
      -- yields NULL[1] = NULL exactly as an empty subquery did.
      (array_agg(UPPER(wmc.tier) ORDER BY
        CASE UPPER(wmc.tier)
          WHEN 'ULTIMATE'  THEN 1
          WHEN 'LEGENDARY' THEN 2
          WHEN 'RARE'      THEN 3
          WHEN 'FANDOM'    THEN 4
          WHEN 'COMMON'    THEN 5
          ELSE 6
        END, UPPER(wmc.tier))
       FILTER (WHERE wmc.tier IS NOT NULL))[1] AS top_tier
    FROM public.wallet_moments_cache wmc
    LEFT JOIN public.editions e
      ON e.external_id = wmc.edition_key
     AND e.collection_id = wmc.collection_id
    LEFT JOIN public.edition_fmv_current efc
      ON efc.edition_id = e.id
    WHERE wmc.wallet_address = p_wallet_addr
    GROUP BY wmc.collection_id
  )
  UPDATE public.saved_wallets sw
  SET
    cached_moment_count  = agg.moment_count,
    cached_fmv_usd       = CASE WHEN agg.fmv_sum > 0 THEN agg.fmv_sum ELSE NULL END,
    cached_fmv_stale_usd = CASE WHEN agg.fmv_stale_sum > 0 THEN agg.fmv_stale_sum ELSE NULL END,
    cached_stale_count   = agg.stale_count,
    cached_top_tier      = agg.top_tier,
    cache_updated_at     = NOW()
  FROM agg
  WHERE sw.user_id       = p_user_id
    AND sw.wallet_addr   = p_wallet_addr
    AND sw.collection_id = agg.collection_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
