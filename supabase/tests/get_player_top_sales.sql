-- DB invariant: public.get_player_top_sales — the Pinnacle branch (a
-- character page's "Top sales"). Added 2026-09-26: it matched
-- pinnacle_editions.character_name (one character per set-level key), so a
-- character the catalog names but no legacy row does read "No recorded sales
-- yet" over real sales. Claims:
--
--   1. Sales of EVERY pin whose Characters trait names the character (a duo pin
--      counts for both), highest price first, routed to the pin (render_id),
--      edition_name = the pin's name.
--   2. A duo character ("Maurice & Cogsworth") matches its joined pin.
--   3. p_limit caps the list; other characters' sales never appear.
--   4. A character the catalog does not name falls through to the legacy read;
--      an unknown slug is [].
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261021134844_audit_20261021_player_top_sales_and_related_editions_skip_another_persons_editions.sql; was:)
-- (supabase/migrations/20260929060006_audit_20260928_pinnacle_top_sales_say_which_pins_are_numbered.sql; before that:)
-- (supabase/migrations/20260926211939_audit_20260926_pinnacle_character_top_sales_read_the_pins.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA extensions;
-- players.id is a uuid (as in prod): the standard path compares it with editions.player_id.
CREATE TABLE public.players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, name text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, player_id uuid, player_name text, name text,
  external_id text, set_name text, tier text, thumbnail_url text);
CREATE TABLE public.sales (
  id bigserial PRIMARY KEY, edition_id uuid, serial_number int, price_usd numeric, marketplace text,
  source text, buyer_address text, seller_address text, nft_id bigint, transaction_hash text, sold_at timestamptz);
-- 2026-10-21: the standard path's name fallback skips another person's editions (helper copied from
-- 20261021034822; not itself pinned).
CREATE TABLE public.player_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, player_id uuid,
  related_player_id uuid, relation text, name text, note text);
CREATE OR REPLACE FUNCTION public.edition_player_is_other_person(p_edition_player_id uuid, p_page_player_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT p_edition_player_id IS NOT NULL
     AND p_edition_player_id IS DISTINCT FROM p_page_player_id
     AND EXISTS (
       SELECT 1 FROM player_relations r
        WHERE (r.relation IN ('parent_of', 'namesake')
               AND ((r.player_id = p_page_player_id AND r.related_player_id = p_edition_player_id)
                 OR (r.player_id = p_edition_player_id AND r.related_player_id = p_page_player_id)))
           OR (r.relation = 'name_change' AND r.player_id = p_edition_player_id)
     )
$function$;
CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, characters text[], character_name text, set_name text,
  variant text, thumbnail_url text, limited_edition boolean);
CREATE TABLE public.pinnacle_sales (
  id bigserial PRIMARY KEY, render_id text, edition_id text, serial_number int,
  sale_price_usd numeric, source text, buyer_address text, seller_address text,
  nft_id bigint, sold_at timestamptz);
CREATE TABLE public.pinnacle_editions (
  id text PRIMARY KEY, character_name text, set_name text, variant_type text, thumbnail_url text);

CREATE OR REPLACE FUNCTION public.get_player_top_sales(p_collection_id uuid, p_player_slug text, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_player        RECORD;
  result          jsonb;
BEGIN
  SELECT p.* INTO v_player
  FROM players p
  WHERE p.collection_id = p_collection_id
    AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
           OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
  LIMIT 1;

  IF v_player IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: the character's PINS from the render catalog — the same
    -- Characters-trait match get_player_editions uses (duos by joined name) —
    -- and their sales by pinnacle_sales.render_id (set on 200,205 of 200,214).
    -- The old read matched pinnacle_editions.character_name, which names ONE
    -- character per set-level key, so a character the catalog names but no
    -- legacy row does (265 pages since 20260926193316) read "No recorded sales
    -- yet" over real sales. Per-pin LATERAL on idx_pinnacle_sales_render_id:
    -- measured 2,088 buffers for Mickey Mouse (54 pins) against 7,578 for a
    -- join that seq-scans the table. A character the catalog does not name
    -- falls through to the old read, unchanged.
    IF EXISTS (
      SELECT 1 FROM pinnacle_catalog pc
      WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))))
    ) THEN
      WITH pins AS (
        SELECT pc.render_id, pc.character_name, pc.set_name, pc.variant, pc.thumbnail_url, pc.limited_edition
        FROM pinnacle_catalog pc
        WHERE (EXISTS (SELECT 1 FROM unnest(pc.characters) c WHERE lower(btrim(c)) = lower(btrim(v_player.name)))
             OR (cardinality(pc.characters) > 1
                 AND lower(btrim(v_player.name)) IN (lower(array_to_string(pc.characters, ' & ')),
                                                     lower(array_to_string(pc.characters, ' ')))))
      ),
      top_sales AS (
        SELECT
          s.id::text                 AS sale_id,
          s.edition_id               AS edition_id,
          p.render_id                AS route_slug,
          v_player.name              AS player_name,
          btrim(p.character_name) || ' (' || p.variant || ')' AS edition_name,
          btrim(p.set_name)          AS set_name,
          p.variant                  AS tier,
          p.thumbnail_url,
          s.serial_number,
          p.limited_edition          AS serial_numbered,
          s.sale_price_usd           AS price_usd,
          NULL::text                 AS marketplace,
          s.source                   AS source,
          s.buyer_address::text      AS buyer_address,
          s.seller_address::text     AS seller_address,
          s.nft_id::text             AS nft_id,
          NULL::text                 AS transaction_hash,
          s.sold_at
        FROM pins p
        CROSS JOIN LATERAL (
          SELECT ps.id, ps.edition_id, ps.serial_number, ps.sale_price_usd, ps.source,
                 ps.buyer_address, ps.seller_address, ps.nft_id, ps.sold_at
          FROM pinnacle_sales ps
          WHERE ps.render_id = p.render_id
          ORDER BY ps.sale_price_usd DESC NULLS LAST, ps.sold_at DESC, ps.id
          LIMIT v_safe_limit
        ) s
        ORDER BY s.sale_price_usd DESC NULLS LAST, s.sold_at DESC, s.id
        LIMIT v_safe_limit
      )
      SELECT COALESCE(jsonb_agg(to_jsonb(top_sales.*)), '[]'::jsonb) INTO result FROM top_sales;
      RETURN result;
    END IF;

    -- Pinnacle path: pinnacle_sales joined to pinnacle_editions on text edition_id
    WITH player_editions AS (
      SELECT id, character_name, set_name, variant_type, thumbnail_url
      FROM pinnacle_editions
      WHERE character_name = v_player.name
    ),
    top_sales AS (
      SELECT
        ps.id::text                AS sale_id,
        pe.id                      AS edition_id,
        pe.id                      AS route_slug,
        pe.character_name          AS player_name,
        pe.set_name,
        pe.variant_type            AS tier,
        pe.thumbnail_url,
        ps.serial_number,
        ps.sale_price_usd          AS price_usd,
        NULL::text                 AS marketplace,
        ps.source                  AS source,
        ps.buyer_address::text     AS buyer_address,
        ps.seller_address::text    AS seller_address,
        ps.nft_id::text            AS nft_id,
        NULL::text                 AS transaction_hash,
        ps.sold_at
      FROM pinnacle_sales ps
      JOIN player_editions pe ON pe.id = ps.edition_id
      ORDER BY ps.sale_price_usd DESC NULLS LAST, ps.sold_at DESC
      LIMIT v_safe_limit
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(top_sales.*)), '[]'::jsonb) INTO result FROM top_sales;
  ELSE
    -- Standard path. 2026-08-31: the per-edition LATERAL is LOAD-BEARING — it is
    -- what lets `sales_<year>_edition_id_price_usd_idx` supply the ordering as a
    -- Merge Append of ordered index scans. The `sold_at DESC` tiebreak INSIDE the
    -- LATERAL is equally load-bearing: without it, an edition whose sales tie at
    -- the cut price truncates arbitrarily and the result set changes.
    WITH player_editions AS (
      SELECT id, name, external_id, set_name, tier::text AS tier, thumbnail_url
      FROM editions
      WHERE collection_id = p_collection_id
        -- 2026-10-21: the name fallback skips an edition linked to ANOTHER PERSON per player_relations
        -- (get_player_detail's rule, 20261021034822): Marvin Harrison Sr.'s page listed Jr.'s Rookie
        -- Revelation sales, labelled "Marvin Harrison" on chain.
        AND (player_id = v_player.id OR (player_name = v_player.name AND NOT public.edition_player_is_other_person(player_id, v_player.id)))
    ),
    top_sales AS (
      SELECT
        sa.id::text                          AS sale_id,
        sa.edition_id::text                  AS edition_id,
        COALESCE(pe.external_id, pe.id::text) AS route_slug,
        v_player.name                        AS player_name,
        pe.name                              AS edition_name,
        pe.set_name,
        pe.tier,
        pe.thumbnail_url,
        sa.serial_number,
        sa.price_usd,
        sa.marketplace::text                 AS marketplace,
        sa.source                            AS source,
        sa.buyer_address::text               AS buyer_address,
        sa.seller_address::text              AS seller_address,
        sa.nft_id::text                      AS nft_id,
        sa.transaction_hash::text            AS transaction_hash,
        sa.sold_at
      FROM player_editions pe
      JOIN LATERAL (
        SELECT s.id, s.edition_id, s.serial_number, s.price_usd, s.marketplace,
               s.source, s.buyer_address, s.seller_address, s.nft_id,
               s.transaction_hash, s.sold_at
        FROM sales s
        WHERE s.edition_id = pe.id
        ORDER BY s.price_usd DESC, s.sold_at DESC
        LIMIT v_safe_limit
      ) sa ON true
      ORDER BY sa.price_usd DESC NULLS LAST, sa.sold_at DESC
      LIMIT v_safe_limit
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(top_sales.*)), '[]'::jsonb) INTO result FROM top_sales;
  END IF;

  RETURN result;
END;
$function$;

\set pin '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''

INSERT INTO public.players (collection_id, name) VALUES
  (:pin::uuid, 'Luke Skywalker'), (:pin::uuid, 'Leia'), (:pin::uuid, 'Han Solo'),
  (:pin::uuid, 'Maurice & Cogsworth'), (:pin::uuid, 'Iron Man');
INSERT INTO public.pinnacle_catalog (render_id, characters, character_name, set_name, variant, thumbnail_url) VALUES
  ('r1', ARRAY['Luke Skywalker'],          'Luke Skywalker',          ' Set A ', 'Standard', '/img/r1'),
  ('r2', ARRAY['Luke Skywalker', 'Leia'],  'Luke Skywalker & Leia',   'Set A',   'Golden',   '/img/r2'),
  ('r3', ARRAY['Han Solo'],                'Han Solo',                'Set B',   'Standard', '/img/r3'),
  ('r4', ARRAY['Maurice', 'Cogsworth'],    'Maurice & Cogsworth',     'Set C',   'Standard', '/img/r4');
INSERT INTO public.pinnacle_sales (render_id, edition_id, serial_number, sale_price_usd, sold_at) VALUES
  ('r1', 'K1', 1, 10, now() - interval '3 days'),
  ('r1', 'K1', 2, 50, now() - interval '2 days'),
  ('r2', 'K1', 3, 30, now() - interval '1 day'),
  ('r3', 'K2', 4, 99, now()),
  ('r4', 'K3', 5, 7,  now());
-- Iron Man exists ONLY in pinnacle_editions (the legacy fallback).
INSERT INTO public.pinnacle_editions (id, character_name, set_name, variant_type, thumbnail_url) VALUES
  ('MRV:Standard:1', 'Iron Man', 'Marvel Set', 'Standard', '/img/m1');
INSERT INTO public.pinnacle_sales (render_id, edition_id, serial_number, sale_price_usd, sold_at) VALUES
  (NULL, 'MRV:Standard:1', 9, 12, now());

-- ── 1. every pin naming the character, price-ordered, routed to the pin ──────
SELECT _assert_eq((SELECT string_agg((x->>'price_usd') || '@' || (x->>'route_slug'), ',') FROM jsonb_array_elements(public.get_player_top_sales(:pin::uuid, 'luke-skywalker', 10)) x),
  '50@r1,30@r2,10@r1', 'Luke: his solo pin and the duo pin, highest first; Han''s 99 never appears');
SELECT _assert_eq((SELECT string_agg((x->>'price_usd') || '@' || (x->>'route_slug'), ',') FROM jsonb_array_elements(public.get_player_top_sales(:pin::uuid, 'leia', 10)) x),
  '30@r2', 'Leia: the duo pin, where she is the SECOND name (no legacy row names her)');
SELECT _assert_eq((public.get_player_top_sales(:pin::uuid, 'luke-skywalker', 10) -> 1 ->> 'edition_name'), 'Luke Skywalker & Leia (Golden)', 'edition_name = the pin''s name');
SELECT _assert_eq((public.get_player_top_sales(:pin::uuid, 'luke-skywalker', 10) -> 0 ->> 'set_name'), 'Set A', 'set name trimmed');

-- ── 2. duo character ──────────────────────────────────────────────────────────
SELECT _assert_eq((public.get_player_top_sales(:pin::uuid, 'maurice-cogsworth', 10) -> 0 ->> 'route_slug'), 'r4', 'a duo character matches its joined pin');

-- ── 3. limit ─────────────────────────────────────────────────────────────────
SELECT _assert_eq(jsonb_array_length(public.get_player_top_sales(:pin::uuid, 'luke-skywalker', 2))::text, '2', 'p_limit caps the list');

-- ── 4. fallback + unknown ────────────────────────────────────────────────────
SELECT _assert_eq((public.get_player_top_sales(:pin::uuid, 'iron-man', 10) -> 0 ->> 'route_slug'), 'MRV:Standard:1', 'a character the catalog does not name falls through to the legacy read');
SELECT _assert_eq(public.get_player_top_sales(:pin::uuid, 'no-such-character', 10)::text, '[]', 'unknown slug -> []');

-- 2026-09-28: serial_numbered = the pin's limited_edition, so an Open Edition
-- sale is "unnumbered", never "serial unresolved"; unknown stays null.
UPDATE public.pinnacle_catalog SET limited_edition = (render_id = 'r1') WHERE render_id IN ('r1', 'r2');
SELECT _assert_eq((SELECT string_agg(DISTINCT (x->>'route_slug') || ':' || COALESCE(x->>'serial_numbered', 'null'), ',') FROM jsonb_array_elements(public.get_player_top_sales(:pin::uuid, 'luke-skywalker', 10)) x),
  'r1:true,r2:false', 'serial_numbered carries the pin''s limited_edition');
SELECT _assert_eq((public.get_player_top_sales(:pin::uuid, 'han-solo', 10) -> 0 ->> 'serial_numbered'), NULL, 'unknown limited_edition stays null, never false');

-- ── 5. (2026-10-21) standard path: a shared LABEL is not a shared PERSON ─────
-- Live: /nfl-all-day/player/marvin-harrison (Sr.) listed Jr.'s Rookie Revelation sales — linked to Jr.,
-- labelled "Marvin Harrison" on chain.
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
INSERT INTO public.players (id, collection_id, name) VALUES
  ('d0000000-0000-4000-8000-000000000001', :AD::uuid, 'Marvin Harrison'),
  ('d0000000-0000-4000-8000-000000000002', :AD::uuid, 'Marvin Harrison Jr.'),
  ('d0000000-0000-4000-8000-000000000003', :AD::uuid, 'Shell Twin'),
  ('d0000000-0000-4000-8000-000000000004', :AD::uuid, 'Shell Twin.');
INSERT INTO public.player_relations (collection_id, player_id, related_player_id, relation) VALUES
  (:AD::uuid, 'd0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'parent_of');
INSERT INTO public.editions (id, collection_id, player_id, player_name, name, external_id, set_name, tier) VALUES
  ('e0000000-0000-4000-8000-000000000001', :AD::uuid, 'd0000000-0000-4000-8000-000000000001', 'Marvin Harrison', 'Sr. Colts', '1', 'Legends', 'RARE'),
  ('e0000000-0000-4000-8000-000000000002', :AD::uuid, 'd0000000-0000-4000-8000-000000000002', 'Marvin Harrison', 'Jr. Rookie', '2', 'Rookie Revelation', 'RARE'),
  -- an UNLINKED edition still matches by name (the fallback the arm exists for)
  ('e0000000-0000-4000-8000-000000000003', :AD::uuid, NULL, 'Marvin Harrison', 'Unlinked', '3', 'Base', 'COMMON'),
  -- a same-person twin row with no relation keeps matching by name
  ('e0000000-0000-4000-8000-000000000004', :AD::uuid, 'd0000000-0000-4000-8000-000000000004', 'Shell Twin', 'Twin', '4', 'Base', 'COMMON');
INSERT INTO public.sales (edition_id, price_usd, sold_at) VALUES
  ('e0000000-0000-4000-8000-000000000001', 100, now()),
  ('e0000000-0000-4000-8000-000000000002', 300, now()),
  ('e0000000-0000-4000-8000-000000000003',  50, now()),
  ('e0000000-0000-4000-8000-000000000004',  20, now());
SELECT _assert_eq((SELECT string_agg(x->>'price_usd', ',') FROM jsonb_array_elements(public.get_player_top_sales(:AD::uuid, 'marvin-harrison', 10)) x),
  '100,50', 'Sr.: his own sale and the unlinked one — never Jr.''s $300');
SELECT _assert_eq((SELECT string_agg(x->>'price_usd', ',') FROM jsonb_array_elements(public.get_player_top_sales(:AD::uuid, 'marvin-harrison-jr-', 10)) x),
  '300', 'Jr.: his own sale by player_id');
SELECT _assert_eq((SELECT string_agg(x->>'price_usd', ',') FROM jsonb_array_elements(public.get_player_top_sales(:AD::uuid, 'shell-twin', 10)) x),
  '20', 'CONTROL: a twin row with no recorded relation still matches by name');

SELECT '✓ get_player_top_sales: all assertions passed' AS result;

ROLLBACK;
