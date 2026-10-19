-- audit_20261019: Pinnacle ASK-unify, last reader — get_edition_detail legacy-key live_ask reads the render floor
--
-- WHY. The grain-migration ASK-unify (docs/strategy/pinnacle-grain-migration-2026-07-17.md)
-- retired the legacy ASK writer (pinnacle-listings-reconcile, 2026-07-17; route deleted
-- 2026-08-21) and its pager (pinnacle_ask_stale_hours). pinnacle_editions.ask_price is
-- FROZEN: 328 rows, newest ask_updated_at 2026-07-17 7:09 AM PT (read 2026-10-19 ~8 AM PT).
-- The legacy set-level-key branch of this function still served that frozen value as
-- live_ask with source 'pinnacle_direct'. No rendered surface reaches it today (the
-- edition page 308s every Pinnacle slug to /pinnacle/moment before calling this), but a
-- field named live_ask must not carry a three-month-old price.
--
-- WHAT. live_ask on the legacy branch = the lowest pinnacle_catalog.floor_ask among the
-- renders bridged to this key (legacy_edition_key = pe.edition_key), stamped with the
-- catalog sweep time. All 328 frozen-ask keys have at least one live render floor.
-- An unbridged key (edition_key NULL) now returns live_ask NULL: there is no live ask.
-- The render branch and the non-Pinnacle branch are unchanged from 20261012232629.
--
-- REVERT: re-apply the CREATE OR REPLACE block of
--   supabase/migrations/20261012232629_audit_20261012_get_edition_detail_carries_description.sql
--
-- anon-exec: unchanged (get_edition_detail) — CREATE OR REPLACE of an existing fn; ACL preserved (no REVOKE here); has_function_privilege anon=false read 2026-10-19 before apply.
CREATE OR REPLACE FUNCTION public.get_edition_detail(p_collection_id uuid, p_route_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  result jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: a render_id is a PIN — answer from the render catalog.
    SELECT jsonb_build_object(
      'id',                pc.render_id,
      'source',            'pinnacle_catalog',
      'collection_id',     v_pinnacle_uuid,
      'collection_slug',   'disney_pinnacle',
      'route_slug',        pc.render_id,
      'external_id',       NULL::text,
      'legacy_edition_key', pc.legacy_edition_key,
      'name',              btrim(pc.character_name) || ' - ' || btrim(pc.set_name) || ' (' || pc.variant || ')',
      'description',       NULL::text,
      'player_name',       btrim(pc.characters[1]),
      'characters',        to_jsonb(pc.characters),
      'set_name',          btrim(pc.set_name),
      'set_slug',          regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g'),
      'tier',              pc.variant,
      'series_label',      CASE WHEN pc.series_name ~ '^[0-9]{4}$'
                                THEN public.series_display_label(p_collection_id, pc.series_name::int)
                                ELSE pc.series_name END,
      'edition_kind',      pc.edition_type,
      'circulation_count', pc.total_minted,
      'is_serialized',     pc.limited_edition,
      'is_chaser',         pc.is_chaser,
      'thumbnail_url',     pc.thumbnail_url,
      'video_url',         NULL::text,
      'team_name',         NULLIF(btrim(regexp_replace(pc.franchises[1], '[™®©]', '', 'g')), ''),
      'first_minted_at',   NULL::timestamptz,
      'fmv',               CASE
        WHEN pc.fmv_usd IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fmv_usd',         pc.fmv_usd,
          'wap_usd',         pc.fmv_wap_usd,
          'floor_usd',       pc.floor_ask,
          'confidence',      pc.fmv_confidence,
          'computed_at',     pc.fmv_computed_at,
          'sales_count_30d', pc.fmv_sales_count_30d,
          'sales_count_7d',  pc.fmv_sales_count_7d,
          'days_since_sale', pc.fmv_days_since_sale,
          'pinnacle_ask',    pc.floor_ask,
          'flowty_ask',      NULL::numeric,
          'cross_market_ask',NULL::numeric,
          'listing_count',   NULL::int,
          'offer_count',     NULL::int,
          'fmv_min',         pc.fmv_usd,
          'fmv_max',         pc.fmv_usd,
          'render_count',    1
        )
      END,
      'live_ask', CASE
        WHEN pc.floor_ask IS NULL THEN NULL
        ELSE jsonb_build_object(
          'price',          pc.floor_ask,
          'source',         'pinnacle_catalog',
          'updated_at',     pc.floor_ask_updated_at
        )
      END
    ) INTO result
    FROM pinnacle_catalog pc
    WHERE pc.render_id = p_route_slug;

    IF result IS NOT NULL THEN RETURN result; END IF;

    -- A legacy set-level key (read below, unchanged).
    SELECT jsonb_build_object(
      'id',                pe.id,
      'source',            'pinnacle_editions',
      'collection_id',     v_pinnacle_uuid,
      'collection_slug',   'disney_pinnacle',
      'route_slug',        pe.id,
      'external_id',       pe.external_id,
      'name',              pe.character_name || ' - ' || pe.set_name || ' (' || pe.variant_type || ')',
      'description',       NULL::text,
      'player_name',       pe.character_name,
      'set_name',          pe.set_name,
      'set_slug',          regexp_replace(lower(pe.set_name), '[^a-z0-9]+', '-', 'g'),
      'tier',              pe.variant_type,
      'series_label',      public.series_display_label(p_collection_id, pe.series_year::int),
      'edition_kind',      pe.edition_type,
      'circulation_count', pe.mint_count,
      'is_serialized',     pe.is_serialized,
      'is_chaser',         pe.is_chaser,
      'thumbnail_url',     pe.thumbnail_url,
      'video_url',         NULL::text,
      'team_name',         pe.franchise,
      'first_minted_at',   pe.minting_date,
      'fmv',               CASE
        WHEN fmv.fmv_usd IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fmv_usd',         fmv.fmv_usd,
          'wap_usd',         fmv.wap_usd,
          'floor_usd',       fmv.floor_usd,
          'confidence',      fmv.confidence,
          'computed_at',     fmv.computed_at,
          'sales_count_30d', fmv.sales_count_30d,
          'sales_count_7d',  fmv.sales_count_7d,
          'days_since_sale', fmv.days_since_sale,
          'pinnacle_ask',    fmv.floor_usd,
          'flowty_ask',      NULL::numeric,
          'cross_market_ask',NULL::numeric,
          'listing_count',   NULL::int,
          'offer_count',     NULL::int,
          'fmv_min',         fmv.fmv_min,
          'fmv_max',         fmv.fmv_max,
          'render_count',    fmv.render_count
        )
      END,
      'live_ask', CASE
        WHEN cf.floor_ask IS NULL THEN NULL
        ELSE jsonb_build_object(
          'price',          cf.floor_ask,
          'source',         'pinnacle_catalog',
          'updated_at',     cf.floor_ask_updated_at
        )
      END
    ) INTO result
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    -- 2026-10-19 ASK-unify: the lowest live render floor under this set-level
    -- key, never the legacy pe.ask_price (frozen since 2026-07-17, no writer).
    LEFT JOIN LATERAL (
      SELECT min(pc.floor_ask) AS floor_ask, max(pc.floor_ask_updated_at) AS floor_ask_updated_at
      FROM pinnacle_catalog pc
      WHERE pc.legacy_edition_key = pe.edition_key
        AND pc.floor_ask IS NOT NULL
    ) cf ON true
    WHERE pe.id = p_route_slug;

    -- 2026-09-26: a legacy key names ONE character for a key that can span
    -- several pins and characters (every Cats & Dogs Vol.1 pin read "Lady").
    -- When the catalog puts more than one character under this key, the row
    -- names the SET, not a character, and lists who is in it.
    IF result IS NOT NULL THEN
      DECLARE
        v_chars text[];
      BEGIN
        SELECT array_agg(DISTINCT btrim(u.ch) ORDER BY btrim(u.ch)) INTO v_chars
        FROM pinnacle_catalog pc
        CROSS JOIN LATERAL unnest(pc.characters) AS u(ch)
        WHERE pc.legacy_edition_key = p_route_slug
          AND btrim(u.ch) NOT IN ('', 'Unknown');
        IF cardinality(v_chars) > 1 THEN
          result := result || jsonb_build_object(
            'name',        (result->>'set_name') || ' (' || (result->>'tier') || ')',
            'player_name', NULL::text,
            'characters',  to_jsonb(v_chars));
        END IF;
      END;
    END IF;

  ELSE
    SELECT jsonb_build_object(
      'id',                e.id::text,
      'source',            'editions',
      'collection_id',     e.collection_id,
      'collection_slug',   c.slug,
      'route_slug',        COALESCE(e.external_id, e.id::text),
      'external_id',       e.external_id,
      'name',              e.name,
      'description',       e.description,
      'player_name',       e.player_name,
      'set_name',          e.set_name,
      'set_slug',          CASE
        WHEN e.set_name IS NULL THEN NULL
        ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g')
      END,
      'tier',              e.tier::text,
      'series_label',      public.series_display_label(p_collection_id, e.series::int),
      'series_num',        e.series,
      'edition_kind',      e.edition_kind::text,
      'circulation_count', e.circulation_count,
      'badges',            (
        SELECT coalesce(jsonb_agg(b->>'title'), '[]'::jsonb)
        FROM jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS b
      ),
      'thumbnail_url',     e.thumbnail_url,
      'video_url',         e.video_url,
      'team_name',         e.team_name,
      'first_minted_at',   e.first_minted_at,
      'fmv', CASE
        WHEN fmv.fmv_usd IS NULL THEN NULL
        ELSE jsonb_build_object(
          'fmv_usd',         fmv.fmv_usd,
          'floor_price_usd', fmv.floor_price_usd,
          'wap_usd',         fmv.wap_usd,
          'confidence',      fmv.confidence::text,
          'computed_at',     fmv.computed_at,
          'sales_count_30d', fmv.sales_count_30d,
          'days_since_sale', fmv.days_since_sale,
          'cross_market_ask',fmv.cross_market_ask
        )
      END
    ) INTO result
    FROM editions e
    JOIN collections c ON c.id = e.collection_id
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd, asp_usd AS wap_usd, confidence, computed_at,
             sales_count_30d, days_since_sale, cross_market_ask
      FROM fmv_snapshots
      WHERE edition_id = e.id
      ORDER BY computed_at DESC
      LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND (e.external_id = p_route_slug OR e.id::text = p_route_slug);
  END IF;

  RETURN result;
END;
$function$;
