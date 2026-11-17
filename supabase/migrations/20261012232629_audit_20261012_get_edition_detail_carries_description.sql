-- audit_20261012_get_edition_detail_carries_description
--
-- WHY (platform review 2026-10-11, item E4). editions.description has carried
-- the upstream prose for the play since 2026-08-12 (migration 20260812025359;
-- lib/editions-hydrate.ts writes it for Top Shot and All Day), and the only
-- reader is rpc_search_catalog. The public edition page and its <meta
-- description> never see it: get_edition_detail, the ONE read the page, its
-- layout gate and generateMetadata share (lib/entity-detail-gate.ts), did not
-- select the column. So every edition page's description is the same template
-- sentence and the paragraph collectors came for is absent.
--
-- WHAT. ONE change to get_edition_detail: the editions arm's jsonb_build_object
-- gains 'description', e.description. The two Pinnacle arms (pinnacle_catalog
-- and the legacy pinnacle_editions key) gain 'description', NULL::text so every
-- arm returns the same key set. Nothing else moves — header, search_path,
-- statement_timeout, every other key and the ORDER of keys are byte-identical
-- to the base. The page renders the paragraph only when it is non-empty and
-- seeds the metadata description from its first sentence (lib/seo.ts); an
-- absent or empty description renders nothing (no "No description" copy).
--
-- BASE. Written on the PINNED body — supabase/tests/pinnacle_readers_use_the_pin_catalog.sql,
-- whose verbatim copy is the registered migration
-- supabase/migrations/20260926215225_audit_20260926_pinnacle_remaining_readers_use_the_pin_catalog.sql
-- __tests__/db-invariants-drift-guard.test.ts PASSED against that pair on
-- 2026-10-12 before this file was written (325/325), so the pin equals the
-- committed DDL. ⚠ The author could NOT read the live database. Before
-- applying, the committer re-reads the live object (CREATE OR REPLACE is a
-- full-body write) and confirms it is this base:
--   SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g')))
--   FROM pg_proc WHERE oid = 'public.get_edition_detail(uuid,text)'::regprocedure;
--   expected BEFORE apply: 927562d82b6808b0b7b155afc6dabc5e
--   expected AFTER  apply: 38574cd05368f299871ca8843e021b89
-- A different BEFORE value means another session redefined the function since
-- 20260926215225 — rebase the one-key change onto the live body (and re-pin)
-- rather than applying this file. (Computed over the committed body with the
-- same normalisation; prosrc is stored verbatim, so the two agree when the
-- committed file is what runs.)
--
-- ACL. CREATE OR REPLACE FUNCTION does not reset a function's ACL, and no
-- REVOKE is added here (one would CHANGE production under a body-only edit).
-- The 20260926215225 apply recorded has_function_privilege('anon', …) = false;
-- the committer re-reads it after apply:
--   SELECT has_function_privilege('anon', 'public.get_edition_detail(uuid,text)', 'EXECUTE');
--
-- CALLERS (unchanged shape, one added nullable key): the edition page family
-- via lib/entity-detail-gate.ts, /api/entity/edition, /api/og/edition, the
-- concierge, lib/sitemap-data.ts. Every consumer reads keys by name; a key
-- they do not read is inert.
--
-- REVERT: re-apply the get_edition_detail body from supabase/migrations/20260926215225_audit_20260926_pinnacle_remaining_readers_use_the_pin_catalog.sql
-- (prosrc md5 927562d82b6808b0b7b155afc6dabc5e after normalisation), then move the pin's
-- migration: pointer and the pin file's verbatim block back to it.

-- anon-exec: unchanged (get_edition_detail) — CREATE OR REPLACE of an existing fn; ACL preserved (no REVOKE here); 20260926215225 recorded has_function_privilege anon=false, re-read by the committer after apply.
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
        WHEN pe.ask_price IS NULL THEN NULL
        ELSE jsonb_build_object(
          'price',          pe.ask_price,
          'source',         pe.ask_source,
          'updated_at',     pe.ask_updated_at
        )
      END
    ) INTO result
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
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
