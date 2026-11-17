-- audit_20261021_player_top_sales_and_related_editions_skip_another_persons_editions
--
-- 2026-10-21 6:48 AM PT (Claude Code cloud; Trevor: "Keep going"). Found by a live sweep of father/son and
-- namesake player pages (CLAUDE.md concierge rule 2: a NAME is not a PERSON).
--
-- WHAT WAS WRONG. Two readers still matched by the edition LABEL after 20261021034822 fixed
-- get_player_detail / get_player_editions:
--  1. get_player_top_sales (standard path): `player_id = v_player.id OR player_name = v_player.name`.
--     /nfl-all-day/player/marvin-harrison (Sr.) listed "Rookie Revelation $300 #6", "$239 #27" and
--     "Holo Icon Signature Edition $280 #1" — Jr.'s editions 3699 / 5078, linked to Jr. but labelled
--     "Marvin Harrison" on chain.
--  2. get_edition_related (the edition page's "More <player> Editions"): `e.player_name = s.player_name`.
--     /nfl-all-day/edition/3699 (Jr.) listed Sr.'s "Playoff Legacies" and "Legends of the Turf".
--
-- WHAT CHANGES. The shared predicate public.edition_player_is_other_person (20261021034822):
--  1. top sales: the name branch skips an edition whose linked player player_relations records as
--     another person (identical to get_player_detail's arm).
--  2. related: src also selects player_id; the player leg skips a candidate when either side's linked
--     player is recorded as a different person from the other (both directions, because a name_change
--     row is keyed on the renamed player, who may be the source or the candidate).
-- A pair with no relation row resolves exactly as before (the helper is FALSE), so every collection
-- without a recorded relation is unaffected. Bodies otherwise byte-identical to their pinned migrations
-- (20260925084253, 20260929060006; live prosrc md5 89019493… / 34ef7a01… re-read and matched first).
-- Applied as md5-guarded splices of the live bodies; the full DDL below is what the pins compare.
--
-- anon-exec: unchanged (get_edition_related) — CREATE OR REPLACE of the same signature keeps its ACL.
-- anon-exec: unchanged (get_player_top_sales) — CREATE OR REPLACE of the same signature keeps its ACL.
--
-- REVERT: re-apply the get_edition_related block of 20260925084253 and the get_player_top_sales block
-- of 20260929060006.

CREATE OR REPLACE FUNCTION public.get_edition_related(p_edition_id uuid, p_limit int DEFAULT 6)
RETURNS TABLE (
  id uuid,
  external_id text,
  player_name text,
  team_name text,
  set_name text,
  tier text,
  series smallint,
  circulation_count integer,
  thumbnail_url text,
  fmv_usd numeric,
  relation text,
  badges text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
WITH src AS (
  SELECT e.id, e.collection_id, e.player_name, e.set_name, e.player_id
  FROM editions e
  WHERE e.id = p_edition_id
),
by_player AS (
  SELECT e.id, e.external_id::text, e.player_name, e.team_name, e.set_name,
         e.tier::text AS tier, e.series, e.circulation_count, e.thumbnail_url,
         f.fmv_usd, 'player'::text AS relation, e.badges
  FROM editions e
  JOIN src s ON e.collection_id = s.collection_id AND e.id <> s.id AND e.player_name = s.player_name
  LEFT JOIN LATERAL (
    SELECT fs.fmv_usd FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id AND fs.computed_at > now() - interval '400 days'
    ORDER BY fs.computed_at DESC LIMIT 1
  ) f ON true
  WHERE s.player_name IS NOT NULL
    AND e.external_id IS NOT NULL
    AND e.external_id !~ '^[0-9a-f]{8}-'
    -- 2026-10-21: a shared LABEL is not a shared PERSON (rule 2). Marvin Harrison Jr.'s Rookie Revelation
    -- (label "Marvin Harrison") listed Sr.'s Colts editions as "More Marvin Harrison Editions". Skip a
    -- candidate when player_relations records its linked player and the source's as different people,
    -- in either direction (a name_change row is keyed on the renamed player, who may be either side).
    AND NOT public.edition_player_is_other_person(e.player_id, s.player_id)
    AND NOT public.edition_player_is_other_person(s.player_id, e.player_id)
  ORDER BY f.fmv_usd DESC NULLS LAST, e.circulation_count ASC NULLS LAST
  LIMIT GREATEST(p_limit, 0)
),
set_ids AS (
  SELECT e.id
  FROM editions e
  JOIN src s ON e.collection_id = s.collection_id AND e.id <> s.id AND e.set_name = s.set_name
  WHERE s.set_name IS NOT NULL
    AND e.external_id IS NOT NULL
    AND e.external_id !~ '^[0-9a-f]{8}-'
    AND e.id NOT IN (SELECT bp.id FROM by_player bp)
  ORDER BY e.circulation_count ASC NULLS LAST, e.id
  LIMIT GREATEST(p_limit, 0)
),
by_set AS (
  SELECT e.id, e.external_id::text, e.player_name, e.team_name, e.set_name,
         e.tier::text AS tier, e.series, e.circulation_count, e.thumbnail_url,
         f.fmv_usd, 'set'::text AS relation, e.badges
  FROM set_ids si
  JOIN editions e ON e.id = si.id
  LEFT JOIN LATERAL (
    SELECT fs.fmv_usd FROM fmv_snapshots fs
    WHERE fs.edition_id = e.id AND fs.computed_at > now() - interval '400 days'
    ORDER BY fs.computed_at DESC LIMIT 1
  ) f ON true
),
u AS (
  SELECT bp.*, 0 AS leg FROM by_player bp
  UNION ALL
  SELECT bs.*, 1 AS leg FROM by_set bs
)
SELECT u.id, u.external_id, u.player_name, u.team_name, u.set_name, u.tier, u.series,
       u.circulation_count, u.thumbnail_url, u.fmv_usd, u.relation, u.badges
FROM u
ORDER BY u.leg, u.fmv_usd DESC NULLS LAST, u.circulation_count ASC NULLS LAST
LIMIT GREATEST(p_limit, 0)
$$;

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
