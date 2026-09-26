-- DB invariant: public.get_team_sets + public.get_team_activity — the Pinnacle
-- branch (a franchise page's Sets and Recent activity). Added 2026-09-26: both
-- read only `editions`, which holds no Pinnacle rows, so both sections were
-- hidden on every franchise page. Claims:
--
--   1. Sets: the franchise's catalog pins (™ stripped, every franchise a pin
--      names) grouped by trimmed set name/slug; editions = pins; cheapest
--      entry = min(floor, else FMV) over priced pins; owned = pins held (by
--      render_id), NULL without a wallet.
--   2. Activity: sales of those pins by render_id, newest first, routed to the
--      pin; both the narrow (per-pin window) and the wide (newest-first walk)
--      lanes return the same rows; limit/offset apply.
--   3. Another franchise's sales never appear; an unknown slug is [].
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926213521_audit_20260926_pinnacle_franchise_pages_show_sets_and_recent_sales.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, franchises text[], characters text[], set_name text,
  variant text, thumbnail_url text, fmv_usd numeric, floor_ask numeric);
CREATE TABLE public.wallet_moments_cache (
  wallet_address text, collection_id uuid, edition_key text, render_id text);
CREATE TABLE public.pinnacle_sales (
  id bigserial PRIMARY KEY, render_id text, serial_number int, sale_price_usd numeric, sold_at timestamptz);

CREATE OR REPLACE FUNCTION public.get_team_sets(p_collection_id uuid, p_team_slug text, p_wallet text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_variants text[];
  result     jsonb;
BEGIN
  -- 2026-09-26: Disney Pinnacle has no `editions` rows, so this section read
  -- [] and the franchise page hid it. Its sets come from the render catalog:
  -- the pins get_team_top_editions lists (each pin's Franchises trait, ™/®/©
  -- stripped), grouped by the trimmed set name — the slug the set pages
  -- resolve — with ownership by the pin a wallet holds (render_id).
  IF p_collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid THEN
    SELECT array_agg(DISTINCT f.name) INTO v_variants
    FROM pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
    WHERE f.name <> ''
      AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH owned AS (
      SELECT DISTINCT w.render_id AS rid
      FROM wallet_moments_cache w
      WHERE p_wallet IS NOT NULL
        AND w.wallet_address = p_wallet
        AND w.collection_id = p_collection_id
        AND w.render_id IS NOT NULL
    ),
    te AS (
      SELECT
        btrim(pc.set_name) AS set_name,
        regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
        pc.fmv_usd,
        pc.floor_ask AS floor_price_usd,
        (o.rid IS NOT NULL) AS owned
      FROM pinnacle_catalog pc
      LEFT JOIN owned o ON o.rid = pc.render_id
      WHERE EXISTS (
          SELECT 1 FROM unnest(pc.franchises) AS u(fr)
          WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_variants))
        AND pc.set_name IS NOT NULL
        AND btrim(pc.set_name) <> ''
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(g.*) ORDER BY g.editions DESC, g.set_name), '[]'::jsonb) INTO result FROM (
      SELECT
        te.set_slug,
        MIN(te.set_name) AS set_name,
        COUNT(*) AS editions,
        MIN(COALESCE(te.floor_price_usd, te.fmv_usd)) FILTER (WHERE COALESCE(te.floor_price_usd, te.fmv_usd) > 0) AS cheapest_entry_usd,
        CASE WHEN p_wallet IS NULL THEN NULL ELSE COUNT(*) FILTER (WHERE te.owned) END AS owned
      FROM te
      GROUP BY te.set_slug
    ) g;
    RETURN result;
  END IF;

  SELECT array_agg(DISTINCT team_name) INTO v_variants
  FROM editions
  WHERE collection_id = p_collection_id
    AND team_name IS NOT NULL
    AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)
  IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

  WITH owned_keys AS (
    SELECT w.edition_key AS ek
    FROM wallet_moments_cache w
    WHERE p_wallet IS NOT NULL
      AND w.wallet_address = p_wallet
      AND w.collection_id = p_collection_id
    GROUP BY w.edition_key
  ),
  te AS (
    SELECT
      e.external_id,
      e.set_name,
      regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') AS set_slug,
      fmv.fmv_usd,
      fmv.floor_price_usd,
      (ok.ek IS NOT NULL) AS owned
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    LEFT JOIN owned_keys ok ON ok.ek = e.external_id
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_variants)
      AND e.set_name IS NOT NULL
      AND e.thumbnail_url IS NOT NULL
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(g.*) ORDER BY g.editions DESC, g.set_name), '[]'::jsonb) INTO result FROM (
    SELECT
      te.set_slug,
      MIN(te.set_name) AS set_name,
      COUNT(*) AS editions,
      MIN(COALESCE(te.floor_price_usd, te.fmv_usd)) FILTER (WHERE COALESCE(te.floor_price_usd, te.fmv_usd) > 0) AS cheapest_entry_usd,
      CASE WHEN p_wallet IS NULL THEN NULL ELSE COUNT(*) FILTER (WHERE te.owned) END AS owned
    FROM te
    GROUP BY te.set_slug
  ) g;

  RETURN result;
END;
$function$;
CREATE OR REPLACE FUNCTION public.get_team_activity(p_collection_id uuid, p_team_slug text, p_limit integer DEFAULT 30, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_variants    text[];
  v_safe_limit  int := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_safe_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_edition_ids uuid[];
  v_n_eds       int;
  v_window      int;
  result        jsonb;
BEGIN
  -- 2026-09-26: Disney Pinnacle has no `editions` rows, so this section read
  -- [] and the franchise page hid it. Its sales are pinnacle_sales of the
  -- franchise's catalog pins (each pin's Franchises trait, ™/®/© stripped) by
  -- render_id, newest first. Same two shapes as the Top Shot lanes below: a
  -- per-pin window on idx_pinnacle_sales_render_id for a narrow franchise, a
  -- newest-first walk for a wide one (measured: Moana 4 pins 779 buffers,
  -- Star Wars 723 pins 719 buffers).
  IF p_collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid THEN
    DECLARE
      v_render_ids text[];
    BEGIN
      SELECT array_agg(DISTINCT f.name) INTO v_variants
      FROM pinnacle_catalog pc
      CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
      CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
      WHERE f.name <> ''
        AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;
      IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

      SELECT array_agg(pc.render_id) INTO v_render_ids
      FROM pinnacle_catalog pc
      WHERE EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_variants));
      IF v_render_ids IS NULL THEN RETURN '[]'::jsonb; END IF;

      v_window := v_safe_limit + v_safe_offset;

      SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result FROM (
        SELECT
          pc.render_id                        AS route_slug,
          btrim(pc.characters[1])             AS player_name,
          btrim(pc.set_name)                  AS set_name,
          v_variants[1]                       AS team_name,
          NULL::text                          AS play_type,
          pc.variant                          AS tier,
          pc.thumbnail_url,
          ts.serial_number,
          ts.price_usd,
          ts.sold_at,
          ts.marketplace
        FROM (
          SELECT cand.render_id, cand.serial_number, cand.price_usd, cand.sold_at, cand.marketplace, cand.id
          FROM (
            SELECT s.render_id, s.serial_number, s.price_usd, s.sold_at, s.marketplace, s.id
            FROM unnest(v_render_ids) AS r(id)
            CROSS JOIN LATERAL (
              SELECT ps.render_id, ps.serial_number, ps.sale_price_usd AS price_usd, ps.sold_at,
                     NULL::text AS marketplace, ps.id
              FROM pinnacle_sales ps
              WHERE ps.render_id = r.id
              ORDER BY ps.sold_at DESC NULLS LAST, ps.id DESC
              LIMIT v_window
            ) s
            WHERE array_length(v_render_ids, 1)::bigint * v_window::bigint <= 2000
            UNION ALL
            SELECT ps.render_id, ps.serial_number, ps.sale_price_usd, ps.sold_at, NULL::text, ps.id
            FROM (
              SELECT ps0.* FROM pinnacle_sales ps0
              WHERE array_length(v_render_ids, 1)::bigint * v_window::bigint > 2000
                AND ps0.render_id = ANY (v_render_ids)
              ORDER BY ps0.sold_at DESC NULLS LAST, ps0.id DESC
              LIMIT v_window
            ) ps
          ) cand
          ORDER BY cand.sold_at DESC NULLS LAST, cand.id DESC
          LIMIT v_safe_limit OFFSET v_safe_offset
        ) ts
        JOIN pinnacle_catalog pc ON pc.render_id = ts.render_id
        ORDER BY ts.sold_at DESC NULLS LAST, ts.id DESC
      ) t;
      RETURN result;
    END;
  END IF;

  SELECT array_agg(DISTINCT team_name) INTO v_variants
  FROM editions
  WHERE collection_id = p_collection_id
    AND team_name IS NOT NULL
    AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));  -- 2026-09-25 (batch 62): the whole franchise, historic labels included; ARRAY(SELECT …) is an InitPlan (the helper runs once)
  IF v_variants IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT array_agg(id) INTO v_edition_ids
  FROM editions
  WHERE collection_id = p_collection_id
    AND team_name = ANY(v_variants);
  IF v_edition_ids IS NULL THEN RETURN '[]'::jsonb; END IF;

  v_n_eds  := COALESCE(array_length(v_edition_ids, 1), 0);
  v_window := v_safe_limit + v_safe_offset;

  IF v_n_eds > 0 AND (v_n_eds::bigint * v_window::bigint) <= 2000 THEN
    -- NARROW TEAM: take each edition's own most-recent window via
    -- sales_YYYY_edition_id_sold_at_idx, then merge. Bounded by the gate above.
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result FROM (
      SELECT
        COALESCE(e.external_id, e.id::text) AS route_slug,
        e.player_name,
        e.set_name,
        e.team_name,
        e.play_type,
        e.tier::text                        AS tier,
        e.thumbnail_url,
        ts.serial_number,
        ts.price_usd,
        ts.sold_at,
        ts.marketplace
      FROM (
        SELECT cand.edition_id, cand.serial_number, cand.price_usd, cand.sold_at, cand.marketplace
        FROM unnest(v_edition_ids) AS ed(id)
        CROSS JOIN LATERAL (
          SELECT s.edition_id, s.serial_number, s.price_usd, s.sold_at, s.marketplace
          FROM sales s
          WHERE s.collection_id = p_collection_id
            AND s.edition_id = ed.id
          ORDER BY s.sold_at DESC
          LIMIT v_window
        ) cand
        ORDER BY cand.sold_at DESC
        LIMIT v_safe_limit OFFSET v_safe_offset
      ) ts
      JOIN editions e ON e.id = ts.edition_id
      ORDER BY ts.sold_at DESC
    ) t;
  ELSE
    -- WIDE TEAM: unchanged from the pre-2026-09-01 body. Do not "simplify" this away.
    SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb) INTO result FROM (
      SELECT
        COALESCE(e.external_id, e.id::text) AS route_slug,
        e.player_name,
        e.set_name,
        e.team_name,
        e.play_type,
        e.tier::text                        AS tier,
        e.thumbnail_url,
        ts.serial_number,
        ts.price_usd,
        ts.sold_at,
        ts.marketplace
      FROM (
        SELECT s.edition_id, s.serial_number, s.price_usd, s.sold_at, s.marketplace
        FROM sales s
        WHERE s.collection_id = p_collection_id
          AND s.edition_id = ANY(v_edition_ids)
        ORDER BY s.sold_at DESC
        LIMIT v_safe_limit OFFSET v_safe_offset
      ) ts
      JOIN editions e ON e.id = ts.edition_id
      ORDER BY ts.sold_at DESC
    ) t;
  END IF;

  RETURN result;
END;
$function$;

\set pin '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set w '''0xabc'''

INSERT INTO public.pinnacle_catalog (render_id, franchises, characters, set_name, variant, thumbnail_url, fmv_usd, floor_ask) VALUES
  ('r1', ARRAY['Star Wars™'], ARRAY['Luke'], ' Set A ', 'Standard', '/img/r1', 10,   8),
  ('r2', ARRAY['Star Wars'],  ARRAY['Leia'], 'Set A',   'Golden',   '/img/r2', 5,    NULL),
  ('r3', ARRAY['Star Wars'],  ARRAY['Han'],  'Set B',   'Standard', '/img/r3', NULL, NULL),
  ('r4', ARRAY['Moana'],      ARRAY['Moana'],'Set C',   'Standard', '/img/r4', 7,    6);
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, render_id) VALUES
  (:w, :pin::uuid, 'K', 'r2'), (:w, :pin::uuid, 'K', 'r2');
INSERT INTO public.pinnacle_sales (render_id, serial_number, sale_price_usd, sold_at) VALUES
  ('r1', 1, 11, now() - interval '5 days'),
  ('r2', 2, 22, now() - interval '1 day'),
  ('r3', 3, 33, now() - interval '3 days'),
  ('r4', 4, 44, now());

-- ── 1. sets ───────────────────────────────────────────────────────────────────
SELECT _assert_eq((SELECT string_agg((x->>'set_slug') || ':' || (x->>'editions') || ':' || COALESCE(x->>'cheapest_entry_usd','null') || ':' || COALESCE(x->>'owned','null'), ',')
                   FROM jsonb_array_elements(public.get_team_sets(:pin::uuid, 'star-wars', NULL)) x),
  'set-a:2:5:null,set-b:1:null:null', 'sets by trimmed slug; cheapest = min(floor 8, FMV 5); unpriced set null; no wallet -> owned null');
SELECT _assert_eq((public.get_team_sets(:pin::uuid, 'star-wars', :w) -> 0 ->> 'owned'), '1', 'owned counts PINS held (r2 twice = 1)');
SELECT _assert_eq((public.get_team_sets(:pin::uuid, 'star-wars', :w) -> 0 ->> 'set_name'), 'Set A', 'set name trimmed');
SELECT _assert_eq(public.get_team_sets(:pin::uuid, 'no-such', NULL)::text, '[]', 'unknown franchise -> []');

-- ── 2. activity: newest first, both lanes agree ─────────────────────────────────
SELECT _assert_eq((SELECT string_agg((x->>'route_slug') || '@' || (x->>'price_usd'), ',') FROM jsonb_array_elements(public.get_team_activity(:pin::uuid, 'star-wars', 30, 0)) x),
  'r2@22,r3@33,r1@11', 'narrow lane: Star Wars sales newest first; Moana''s never appear');
-- a window of 1000 x 3 pins > 2000 takes the wide lane
SELECT _assert_eq((SELECT string_agg((x->>'route_slug') || '@' || (x->>'price_usd'), ',') FROM jsonb_array_elements(public.get_team_activity(:pin::uuid, 'star-wars', 100, 900)) x),
  NULL, 'wide lane past the end -> empty');
SELECT _assert_eq((SELECT string_agg(x->>'route_slug', ',') FROM jsonb_array_elements(public.get_team_activity(:pin::uuid, 'star-wars', 1, 1)) x),
  'r3', 'offset/limit apply');
SELECT _assert_eq((public.get_team_activity(:pin::uuid, 'star-wars', 30, 0) -> 0 ->> 'team_name'), 'Star Wars', 'team_name without ™');
SELECT _assert_eq((public.get_team_activity(:pin::uuid, 'star-wars', 30, 0) -> 0 ->> 'player_name'), 'Leia', 'player_name = the pin''s character');
SELECT _assert_eq(public.get_team_activity(:pin::uuid, 'no-such', 30, 0)::text, '[]', 'unknown franchise -> []');

-- the wide lane on real rows: 700 extra Star Wars pins push pins x window past 2000
INSERT INTO public.pinnacle_catalog (render_id, franchises, characters, set_name, variant)
  SELECT 'x' || g, ARRAY['Star Wars'], ARRAY['Extra'], 'Set Z', 'Standard' FROM generate_series(1, 700) g;
SELECT _assert_eq((SELECT string_agg((x->>'route_slug') || '@' || (x->>'price_usd'), ',') FROM jsonb_array_elements(public.get_team_activity(:pin::uuid, 'star-wars', 30, 0)) x),
  'r2@22,r3@33,r1@11', 'wide lane returns the same rows as the narrow one');

SELECT '✓ get_team_sets + get_team_activity: all assertions passed' AS result;

ROLLBACK;
