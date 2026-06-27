# Wave 3 (partial) + deals TS leg — Cowork autonomous block, 2026-06-07 ~02:00–02:30Z

All DB-side, shipped live via Supabase migrations, each verified post-apply. No code deploy involved. This doc is the capture-of-record for the dropped function bodies (their migration comments point here).

## Shipped (4 migrations)

1. **`audit_20260607_cross_collection_deals_topshot_low_ask_leg`** — added a Top Shot leg to `get_cross_collection_deals`: `badge_editions.low_ask` (live hourly ask feed) vs latest `fmv_snapshots` per edition. Gates mirror the Pinnacle leg: HIGH/MEDIUM, `sales_count_30d >= 8`, ask freshness ≤24h. buy_url = public RPC edition page (`/nba-top-shot/edition/<setID>%3A<playID>`). Verified: feed went 15 deals (100% Pinnacle) → **152 deals (137 TS avg 28.7%, 15 Pinnacle avg 25.1%)**; top TS rows are high-volume falling rookies (honest discounts with confidence labels). The weekly digest's Top Deals is now genuinely cross-collection. Revert: re-apply `audit_20260606_cross_collection_deals_pinnacle_liquidity_gate` (drops the ts_ask_deals CTE).
2. **`audit_20260607_health_views_pinnacle_render_spine`** — re-pointed the Pinnacle legs of `data_coverage_dashboard`, `data_quality`, `pipeline_health` at the render spine. Key fixes: `pipeline_health` `fmv:pinnacle` now watches `pinnacle_catalog.fmv_computed_at` (the LIVE engine — closes the freshness blind-spot class that hid the 2026-06-03 2.4-day freeze); `listings:pinnacle` now watches `floor_ask_updated_at` instead of 142 frozen Flowty rows (was permanent stale-noise). `data_quality` Pinnacle: 2,079 editions / 1,790 priced (86.1%) / 214 HIGH / 1,946 floors / 0 unmapped / health "good". security_invoker=true preserved on all three. Revert: prior viewdefs in the 2026-06-07 session transcript.
3. **`audit_20260607_health_checks_pinnacle_render_spine`** — same re-point for `health_check()` (SECDEF; collections.disney_pinnacle editions/fmv_editions now catalog-sourced) and `pinnacle_health_check()` (catalog counts, `latest_fmv` = `max(fmv_computed_at)`, `distinct_editions_traded` by render_id). JSON keys unchanged. Verified both return 2,079/1,790 with the live engine timestamp.
4. **`audit_20260607_drop_orphan_pinnacle_legacy_readers`** — DROPPED the 5 orphaned legacy readers (zero repo callers by grep over app/lib/workers/scripts; `pg_stat_user_functions` lifetime_calls = 0 on all): `get_pinnacle_edition_fmv(text)`, `get_pinnacle_overview()`, `get_pinnacle_top_movers(int,int)`, `moment_detail(text,text)`, `get_pinnacle_moment_detail(text)`. Bodies below.

## Remaining pinnacle_fmv_snapshots readers (full wave-3 gate)

After this block: `analytics_data_quality_overview`, `analytics_liquidity_distribution`, `analytics_smoke_run` (read a live-but-deprecated table — re-point at retirement), the entity/team fn vestigial legs (~15 fns, no live Pinnacle routes through them), `get_moment_detail` (keeps legacy keys deliberately — additive renders[] shipped by CC in b3e9f06), and the legacy writer chain (`pinnacle_fmv_from_listings`, `pinnacle_fmv_from_sales`, `pinnacle_fmv_recalc_all`, `bridge_pinnacle_fmv_to_main`). Retire table+writers only when that list is zero.

## Also verified this block (no action)

- `topshot-fmv-populate` 00:00 UTC tick: **logged** (the after() fix working — first pipeline_runs row since 06-05 18:03) with ok=false `sets read failed: pool timeout` at stage sets_read — the documented intermittent pool-contention class at the cron-rush peak, now visible instead of silent. Watch the 06:00 UTC tick.
- `pinnacle-wmc-render-id` hourly: 4/4 ok. `pinnacle-sync` ok=true post-PIN-SYNC-FLOWTY. `wmc-fmv-populate` legs green.
- `allow_list`: 0 pending signups (Dumbo not through the flow yet).

## Dropped function bodies (revert capture)

If any is re-created, re-apply explicit REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role; (DROP loses the prior acl; several had service-role-only or default postures — treat all as service_role-only on revival).

### get_pinnacle_edition_fmv

```sql
CREATE OR REPLACE FUNCTION public.get_pinnacle_edition_fmv(p_edition_key text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result json;
BEGIN
  SELECT json_build_object(
    'edition_id', f.edition_id,
    'fmv_usd', f.fmv_usd,
    'wap_usd', f.wap_usd,
    'wap_without_outliers', f.wap_without_outliers,
    'floor_usd', f.floor_usd,
    'confidence', f.confidence,
    'liquidity_rating', f.liquidity_rating,
    'sales_count_30d', f.sales_count_30d,
    'days_since_sale', f.days_since_sale,
    'algo_version', f.algo_version,
    'computed_at', f.computed_at
  ) INTO result
  FROM pinnacle_fmv_snapshots f
  JOIN pinnacle_editions e ON e.id = f.edition_id
  WHERE e.edition_key = p_edition_key
  ORDER BY f.computed_at DESC
  LIMIT 1;

  RETURN COALESCE(result, '{}'::json);
END;
$function$;
```

### get_pinnacle_overview

```sql
CREATE OR REPLACE FUNCTION public.get_pinnacle_overview()
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN json_build_object(
    'total_editions', (SELECT COUNT(*) FROM pinnacle_editions),
    'editions_by_studio', (
      SELECT COALESCE(json_object_agg(studio_short, cnt), '{}')
      FROM (
        SELECT
          CASE franchise
            WHEN 'Walt Disney Animation Studios' THEN 'Disney'
            WHEN 'Pixar Animation Studios' THEN 'Pixar'
            WHEN 'Lucasfilm Ltd.' THEN 'Star Wars'
            WHEN '20th Century Studios' THEN '20th Century'
            ELSE franchise
          END as studio_short,
          COUNT(*)::int as cnt
        FROM pinnacle_editions
        GROUP BY studio_short
      ) sub
    ),
    'editions_by_variant', (
      SELECT COALESCE(json_object_agg(variant_type, cnt), '{}')
      FROM (
        SELECT variant_type, COUNT(*)::int as cnt
        FROM pinnacle_editions
        GROUP BY variant_type
        ORDER BY pinnacle_variant_rank(variant_type)
      ) sub
    ),
    'total_sets', (SELECT COUNT(DISTINCT set_name) FROM pinnacle_editions),
    'total_characters', (SELECT COUNT(DISTINCT character_name) FROM pinnacle_editions),
    'total_sales', (SELECT COUNT(*) FROM pinnacle_sales),
    'total_volume', (SELECT COALESCE(SUM(sale_price_usd), 0) FROM pinnacle_sales),
    'volume_30d', (SELECT COALESCE(SUM(sale_price_usd), 0) FROM pinnacle_sales WHERE sold_at > NOW() - interval '30 days'),
    'sales_30d', (SELECT COUNT(*) FROM pinnacle_sales WHERE sold_at > NOW() - interval '30 days'),
    'avg_price_30d', (SELECT ROUND(AVG(sale_price_usd), 2) FROM pinnacle_sales WHERE sold_at > NOW() - interval '30 days'),
    'fmv_editions', (SELECT COUNT(*) FROM pinnacle_fmv_snapshots WHERE fmv_usd > 0),
    'fmv_coverage_pct', ROUND(
      COALESCE(
        (SELECT COUNT(*)::numeric FROM pinnacle_fmv_snapshots WHERE fmv_usd > 0) /
        NULLIF((SELECT COUNT(*)::numeric FROM pinnacle_editions), 0) * 100
      , 0), 1
    ),
    'top_characters_30d', (
      SELECT COALESCE(json_agg(json_build_object(
        'character', character_name, 'volume', vol, 'sales', cnt
      ) ORDER BY vol DESC), '[]')
      FROM (
        SELECT pe.character_name, 
               ROUND(SUM(s.sale_price_usd), 2) as vol,
               COUNT(*)::int as cnt
        FROM pinnacle_sales s
        JOIN pinnacle_editions pe ON pe.id = s.edition_id
        WHERE s.sold_at > NOW() - interval '30 days'
        GROUP BY pe.character_name
        ORDER BY vol DESC
        LIMIT 10
      ) sub
    ),
    'computed_at', NOW()
  );
END;
$function$;
```

### get_pinnacle_top_movers

```sql
CREATE OR REPLACE FUNCTION public.get_pinnacle_top_movers(p_days integer DEFAULT 7, p_limit integer DEFAULT 10)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result json;
BEGIN
  SELECT COALESCE(json_agg(json_build_object(
    'edition_id', edition_id,
    'character_name', character_name,
    'set_name', set_name,
    'variant_type', variant_type,
    'franchise', franchise,
    'current_fmv', current_fmv,
    'previous_fmv', previous_fmv,
    'change_usd', change_usd,
    'change_pct', change_pct
  ) ORDER BY abs_change_pct DESC), '[]'::json)
  INTO result
  FROM (
    SELECT
      f.edition_id,
      pe.character_name,
      pe.set_name,
      pe.variant_type,
      pe.franchise,
      f.fmv_usd as current_fmv,
      (SELECT ROUND(AVG(s.sale_price_usd), 4)
       FROM pinnacle_sales s
       WHERE s.edition_id = f.edition_id
         AND s.sold_at < NOW() - (p_days || ' days')::interval
         AND s.sold_at > NOW() - ((p_days * 2) || ' days')::interval
      ) as previous_fmv,
      f.fmv_usd - COALESCE(
        (SELECT ROUND(AVG(s.sale_price_usd), 4)
         FROM pinnacle_sales s
         WHERE s.edition_id = f.edition_id
           AND s.sold_at < NOW() - (p_days || ' days')::interval
           AND s.sold_at > NOW() - ((p_days * 2) || ' days')::interval
        ), f.fmv_usd
      ) as change_usd,
      ROUND(
        (f.fmv_usd - COALESCE(
          (SELECT ROUND(AVG(s.sale_price_usd), 4)
           FROM pinnacle_sales s
           WHERE s.edition_id = f.edition_id
             AND s.sold_at < NOW() - (p_days || ' days')::interval
             AND s.sold_at > NOW() - ((p_days * 2) || ' days')::interval
          ), f.fmv_usd
        )) / NULLIF(COALESCE(
          (SELECT ROUND(AVG(s.sale_price_usd), 4)
           FROM pinnacle_sales s
           WHERE s.edition_id = f.edition_id
             AND s.sold_at < NOW() - (p_days || ' days')::interval
             AND s.sold_at > NOW() - ((p_days * 2) || ' days')::interval
          ), f.fmv_usd
        ), 0) * 100
      , 1) as change_pct,
      ABS(ROUND(
        (f.fmv_usd - COALESCE(
          (SELECT ROUND(AVG(s.sale_price_usd), 4)
           FROM pinnacle_sales s
           WHERE s.edition_id = f.edition_id
             AND s.sold_at < NOW() - (p_days || ' days')::interval
             AND s.sold_at > NOW() - ((p_days * 2) || ' days')::interval
          ), f.fmv_usd
        )) / NULLIF(COALESCE(
          (SELECT ROUND(AVG(s.sale_price_usd), 4)
           FROM pinnacle_sales s
           WHERE s.edition_id = f.edition_id
             AND s.sold_at < NOW() - (p_days || ' days')::interval
             AND s.sold_at > NOW() - ((p_days * 2) || ' days')::interval
          ), f.fmv_usd
        ), 0) * 100
      , 1)) as abs_change_pct
    FROM pinnacle_fmv_snapshots f
    JOIN pinnacle_editions pe ON pe.id = f.edition_id
    WHERE f.fmv_usd > 0
    ORDER BY abs_change_pct DESC
    LIMIT p_limit
  ) sub;

  RETURN result;
END;
$function$;
```

### moment_detail

```sql
CREATE OR REPLACE FUNCTION public.moment_detail(p_wallet text, p_moment_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := lower(trim(p_wallet));
  v_wmc wallet_moments_cache%ROWTYPE;
  v_collection_slug text;
  v_edition editions%ROWTYPE;
  v_pinnacle_edition pinnacle_editions%ROWTYPE;
  v_fmv_data jsonb;
  v_recent_sales jsonb;
  v_listings jsonb;
BEGIN
  SELECT * INTO v_wmc
  FROM wallet_moments_cache 
  WHERE wallet_address = v_wallet AND moment_id = p_moment_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'moment_not_found', 'wallet', v_wallet, 'moment_id', p_moment_id);
  END IF;

  SELECT slug INTO v_collection_slug FROM collections WHERE id = v_wmc.collection_id;

  IF v_collection_slug = 'disney_pinnacle' THEN
    SELECT * INTO v_pinnacle_edition
    FROM pinnacle_editions 
    WHERE edition_key = v_wmc.edition_key
    LIMIT 1;

    SELECT jsonb_build_object(
      'fmv_usd', fmv_usd,
      'computed_at', computed_at
    ) INTO v_fmv_data
    FROM pinnacle_fmv_snapshots
    WHERE edition_id = v_pinnacle_edition.id
    ORDER BY computed_at DESC
    LIMIT 1;
  ELSE
    SELECT * INTO v_edition
    FROM editions 
    WHERE external_id = v_wmc.edition_key 
      AND collection_id = v_wmc.collection_id
    LIMIT 1;

    SELECT jsonb_build_object(
      'fmv_usd', fmv_usd,
      'floor_price_usd', floor_price_usd,
      'wap_usd', wap_usd,
      'confidence', confidence::text,
      'sales_count_7d', sales_count_7d,
      'sales_count_30d', sales_count_30d,
      'unique_buyers_30d', unique_buyers_30d,
      'listing_count', listing_count,
      'liquidity_rating', liquidity_rating,
      'days_since_sale', days_since_sale,
      'computed_at', computed_at
    ) INTO v_fmv_data
    FROM fmv_snapshots_2026
    WHERE edition_id = v_edition.id
    ORDER BY computed_at DESC
    LIMIT 1;

    SELECT jsonb_agg(jsonb_build_object(
      'price_usd', price_usd,
      'serial_number', serial_number,
      'sold_at', sold_at,
      'source', source
    ) ORDER BY sold_at DESC) INTO v_recent_sales
    FROM (
      SELECT price_usd, serial_number, sold_at, source
      FROM sales_2026
      WHERE edition_id = v_edition.id
      ORDER BY sold_at DESC
      LIMIT 5
    ) s;

    IF v_collection_slug = 'nba_top_shot' AND v_edition.id IS NOT NULL THEN
      SELECT jsonb_agg(listing_data ORDER BY ask_price ASC) INTO v_listings
      FROM (
        SELECT 
          jsonb_build_object(
            'ask_price', ask_price,
            'serial_number', serial_number,
            'source', source,
            'cached_at', cached_at,
            'discount', discount
          ) AS listing_data,
          ask_price
        FROM cached_listings cl
        WHERE cl.collection_id = v_wmc.collection_id
          AND cl.player_name = v_edition.player_name
          AND cl.set_name = v_edition.set_name
        ORDER BY ask_price ASC
        LIMIT 5
      ) l;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'moment_id', p_moment_id,
    'collection', v_collection_slug,
    'core', jsonb_build_object(
      'serial_number', v_wmc.serial_number,
      'edition_key', v_wmc.edition_key,
      'edition_name', v_wmc.edition_name,
      'player_name', COALESCE(v_wmc.player_name, v_wmc.character_name, v_edition.player_name, v_pinnacle_edition.character_name),
      'set_name', COALESCE(v_wmc.set_name, v_edition.set_name, v_pinnacle_edition.set_name),
      'tier', COALESCE(v_wmc.tier, v_edition.tier::text),
      'series_number', COALESCE(v_wmc.series_number, v_edition.series),
      'image_url', COALESCE(v_wmc.image_url, v_edition.thumbnail_url, v_pinnacle_edition.thumbnail_url),
      'mint_count', COALESCE(v_wmc.mint_count, v_edition.circulation_count, v_pinnacle_edition.mint_count),
      'is_locked', v_wmc.is_locked,
      'acquired_at', v_wmc.acquired_at,
      'last_seen_at', v_wmc.last_seen_at
    ),
    'edition', CASE
      WHEN v_collection_slug = 'disney_pinnacle' AND v_pinnacle_edition.id IS NOT NULL THEN
        jsonb_build_object(
          'id', v_pinnacle_edition.id,
          'edition_key', v_pinnacle_edition.edition_key,
          'character_name', v_pinnacle_edition.character_name,
          'franchise', v_pinnacle_edition.franchise,
          'set_name', v_pinnacle_edition.set_name,
          'variant_type', v_pinnacle_edition.variant_type,
          'edition_type', v_pinnacle_edition.edition_type,
          'mint_count', v_pinnacle_edition.mint_count,
          'is_chaser', v_pinnacle_edition.is_chaser,
          'series_year', v_pinnacle_edition.series_year
        )
      WHEN v_collection_slug != 'disney_pinnacle' AND v_edition.id IS NOT NULL THEN
        jsonb_build_object(
          'id', v_edition.id,
          'external_id', v_edition.external_id,
          'name', v_edition.name,
          'player_name', v_edition.player_name,
          'team_name', v_edition.team_name,
          'set_name', v_edition.set_name,
          'tier', v_edition.tier::text,
          'series', v_edition.series,
          'circulation_count', v_edition.circulation_count,
          'first_minted_at', v_edition.first_minted_at,
          'play_category', v_edition.play_category,
          'play_type', v_edition.play_type
        )
      ELSE NULL
    END,
    'fmv', v_fmv_data,
    'recent_sales', COALESCE(v_recent_sales, '[]'::jsonb),
    'active_listings', COALESCE(v_listings, '[]'::jsonb),
    'metadata_status', CASE
      WHEN v_wmc.edition_key IS NULL THEN 'metadata_pending'
      WHEN v_collection_slug = 'disney_pinnacle' AND v_pinnacle_edition.id IS NULL THEN 'edition_unresolved'
      WHEN v_collection_slug != 'disney_pinnacle' AND v_edition.id IS NULL THEN 'edition_unresolved'
      ELSE 'full'
    END
  );
END;
$function$;
```

### get_pinnacle_moment_detail

```sql
CREATE OR REPLACE FUNCTION public.get_pinnacle_moment_detail(p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ed       pinnacle_editions%ROWTYPE;
  v_fmv      jsonb;
  v_avg      numeric;
  v_holders  bigint;
  v_lookup_key text;
BEGIN
  SELECT * INTO v_ed FROM pinnacle_editions WHERE id = p_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT to_jsonb(t)
    INTO v_fmv
  FROM (
    SELECT fmv_usd, confidence, computed_at, sales_count_30d, days_since_sale
    FROM pinnacle_fmv_snapshots
    WHERE edition_id = p_id
    ORDER BY computed_at DESC
    LIMIT 1
  ) t;

  IF v_ed.variant_type IS NOT NULL THEN
    SELECT AVG(mint_count)
      INTO v_avg
    FROM pinnacle_editions
    WHERE variant_type = v_ed.variant_type
      AND mint_count IS NOT NULL;
  END IF;

  v_lookup_key := COALESCE(v_ed.edition_key, v_ed.id);
  SELECT COUNT(*)
    INTO v_holders
  FROM wallet_moments_cache
  WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
    AND edition_key = v_lookup_key;

  RETURN jsonb_build_object(
    'ed', jsonb_build_object(
      'id', v_ed.id,
      'external_id', v_ed.external_id,
      'edition_key', v_ed.edition_key,
      'character_name', v_ed.character_name,
      'franchise', v_ed.franchise,
      'set_name', v_ed.set_name,
      'variant_type', v_ed.variant_type,
      'edition_type', v_ed.edition_type,
      'mint_count', v_ed.mint_count,
      'is_chaser', v_ed.is_chaser,
      'thumbnail_url', v_ed.thumbnail_url,
      'studio', v_ed.studio,
      'materials', v_ed.materials,
      'effects', v_ed.effects,
      'size', v_ed.size,
      'color', v_ed.color,
      'thickness', v_ed.thickness,
      'minting_date', v_ed.minting_date,
      'ask_price', v_ed.ask_price,
      'ask_source', v_ed.ask_source,
      'series_year', v_ed.series_year
    ),
    'fmv', v_fmv,
    'variant_avg_mint', v_avg,
    'holders_cached', v_holders
  );
END;
$function$;
```
