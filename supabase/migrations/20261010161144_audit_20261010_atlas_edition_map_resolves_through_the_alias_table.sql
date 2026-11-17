-- audit_20261010_atlas_edition_map_resolves_through_the_alias_table  (known-issues #175, follow-up)
--
-- FOUND 2026-10-10 ~9:07 AM PT (Cowork cloud), 10 minutes after `20261010155627` re-keyed the Diced
-- aliases: `edition_offers` held a NEW `149:5379::8` row (updated 9:01:00, set_uuid NULL). The writer was
-- not the two app lanes the first migration fixed but a pg_cron one — `sync_edition_offers_from_atlas`
-- keys its floor/offer upserts on `topshot_atlas_edition_map.external_id`, and that map carried the 25
-- alias keys (Atlas editions 10107–10155 → `149:<play>::8`, 0 rows for `152:<play>`). The map is read by
-- 17 functions (sales, listings, offers, moment hydrate, verify dispatch, pack pulls …), several on
-- `rpc_edition_id` — so Atlas-sourced SALES and LISTINGS for the Diced printing would also land on the
-- alias edition. "Grep the DB for a TABLE's WRITERS": the one alias point has to be consulted by the map.
--
-- THE FIX, two halves:
--   1. `upsert_topshot_atlas_edition_map` resolves the edition it matched through
--      `canonical_topshot_external_id()` before writing, so an Atlas edition whose (set, play, parallel)
--      matches an ALIAS catalogue row is mapped to the CANONICAL edition (id and key). ON CONFLICT is on
--      `rpc_edition_id`, so a re-run upserts the canonical row and never re-creates an alias row.
--   2. the 25 live map rows are re-pointed (rpc_edition_id + external_id → canonical), archived in
--      flowty_archive.audit_20261010_175_alias_rekeys (tbl 'atlas_map', row_key = atlas_edition_id), and
--      the one re-created `edition_offers` alias row is re-keyed the way step 3 of `20261010155627` did.
--
-- Falsifier: any `topshot_atlas_edition_map` or `edition_offers` row keyed to a `149:<play>::8` edition
-- after this applies.
--
-- REVERT:
--   UPDATE public.topshot_atlas_edition_map m
--      SET rpc_edition_id = split_part(a.old_value, '|', 1)::uuid, external_id = split_part(a.old_value, '|', 2)
--     FROM flowty_archive.audit_20261010_175_alias_rekeys a
--    WHERE a.tbl = 'atlas_map' AND a.row_key = m.atlas_edition_id;
--   then re-apply the body of upsert_topshot_atlas_edition_map from 20260904055030.

-- anon-exec: unchanged (upsert_topshot_atlas_edition_map) — CREATE OR REPLACE of an existing fn, same signature; ACL re-asserted below (postgres + service_role only).
CREATE OR REPLACE FUNCTION public.upsert_topshot_atlas_edition_map(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH incoming AS (
    SELECT
      (r->>'atlas_edition_id')::text   AS atlas_edition_id,
      (r->>'set_id_onchain')::integer  AS set_id_onchain,
      (r->>'play_id_onchain')::integer AS play_id_onchain,
      NULLIF(r->>'num_minted','')::integer AS num_minted,
      NULLIF(r->>'tier','')            AS tier,
      NULLIF(r->>'parallel','')        AS parallel
    FROM jsonb_array_elements(p_rows) r
    WHERE r->>'atlas_edition_id'  IS NOT NULL
      AND r->>'set_id_onchain'    IS NOT NULL
      AND r->>'play_id_onchain'   IS NOT NULL
  ),
  matched AS (
    SELECT DISTINCT ON (e.id)
      e.id AS matched_edition_id, e.external_id AS matched_external_id,
      i.set_id_onchain, i.play_id_onchain, i.atlas_edition_id, i.num_minted, i.tier, i.parallel
    FROM incoming i
    JOIN public.editions e
      ON e.collection_id   = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND e.set_id_onchain  = i.set_id_onchain
     AND e.play_id_onchain = i.play_id_onchain
     -- parallel-exact when the runner sends it; a legacy row (no parallel) may match any printing
     AND (i.parallel IS NULL OR COALESCE(e.subedition_name, 'Standard') = i.parallel)
    ORDER BY e.id,
             (i.parallel IS NOT NULL) DESC,          -- an exact parallel match beats a legacy row
             i.num_minted DESC NULLS LAST             -- legacy fallback: the largest printing is the Standard
  ),
  -- #175 (2026-10-10): the catalogue row Atlas's (set, play, parallel) matches may be an ALIAS of
  -- the edition the chain mints (the Diced printing: Atlas says set 149 parallel 8, the chain says
  -- set 152). Resolve through the one alias table, so the map — and every reader keyed on it —
  -- lands on the canonical edition. A non-alias resolves to itself.
  joined AS (
    SELECT DISTINCT ON (c.id)
      c.id AS rpc_edition_id, c.external_id,
      m.set_id_onchain, m.play_id_onchain, m.atlas_edition_id, m.num_minted, m.tier, m.parallel
    FROM matched m
    JOIN public.editions c
      ON c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND c.external_id   = public.canonical_topshot_external_id(m.matched_external_id)
    ORDER BY c.id, (c.id = m.matched_edition_id) DESC
  ),
  ins AS (
    INSERT INTO public.topshot_atlas_edition_map AS m
      (rpc_edition_id, external_id, set_id_onchain, play_id_onchain, atlas_edition_id, num_minted, tier, parallel, mapped_at)
    SELECT rpc_edition_id, external_id, set_id_onchain, play_id_onchain, atlas_edition_id, num_minted, tier, parallel, now()
    FROM joined
    ON CONFLICT (rpc_edition_id) DO UPDATE
      SET atlas_edition_id = EXCLUDED.atlas_edition_id,
          num_minted       = EXCLUDED.num_minted,
          tier             = EXCLUDED.tier,
          parallel         = EXCLUDED.parallel,
          mapped_at        = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END
$$;
REVOKE EXECUTE ON FUNCTION public.upsert_topshot_atlas_edition_map(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_topshot_atlas_edition_map(jsonb) TO postgres, service_role;

-- 2. Re-point the live alias map rows to the canonical edition (archive first).
WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
tgt AS (
  SELECT m.atlas_edition_id, m.rpc_edition_id AS old_id, m.external_id AS old_key, c.id AS new_id, c.external_id AS new_key
  FROM public.topshot_atlas_edition_map m
  JOIN public.topshot_edition_aliases x ON x.alias_external_id = m.external_id
  JOIN public.editions c ON c.external_id = x.canonical_external_id AND c.collection_id = (SELECT id FROM ts)
  -- conflict-free only: the canonical edition must not already hold a map row
  WHERE NOT EXISTS (SELECT 1 FROM public.topshot_atlas_edition_map m2 WHERE m2.rpc_edition_id = c.id)
),
arch AS (
  INSERT INTO flowty_archive.audit_20261010_175_alias_rekeys (tbl, row_key, old_value, new_value)
  SELECT 'atlas_map', atlas_edition_id, old_id::text || '|' || old_key, new_id::text || '|' || new_key FROM tgt
  RETURNING row_key
)
UPDATE public.topshot_atlas_edition_map m
   SET rpc_edition_id = t.new_id, external_id = t.new_key, mapped_at = now()
  FROM tgt t
 WHERE m.atlas_edition_id = t.atlas_edition_id AND m.rpc_edition_id = t.old_id;

-- 3. Re-key any edition_offers alias row a pre-fix tick re-created (same rule as 20261010155627 step 3).
WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
arch AS (
  INSERT INTO flowty_archive.audit_20261010_175_alias_rekeys (tbl, row_key, old_value, new_value)
  SELECT 'edition_offers', eo.collection_id::text || '|' || eo.external_id, eo.external_id, x.canonical_external_id
  FROM public.edition_offers eo
  JOIN public.topshot_edition_aliases x ON x.alias_external_id = eo.external_id
  WHERE eo.collection_id = (SELECT id FROM ts)
    AND NOT EXISTS (SELECT 1 FROM public.edition_offers c WHERE c.collection_id = eo.collection_id AND c.external_id = x.canonical_external_id)
  RETURNING row_key, old_value, new_value
)
UPDATE public.edition_offers eo
   SET external_id = arch.new_value, updated_at = now()
  FROM arch
 WHERE eo.collection_id = (SELECT id FROM ts) AND eo.external_id = arch.old_value;

-- 3b. An alias row whose canonical row ALREADY exists (the pre-fix tick wrote the alias after step 3 of
--     20261010155627 had merged the earlier one): it is the newer Atlas observation of the same Atlas
--     edition, so its market columns move to the canonical row when they are newer, and the alias row is
--     left with NO market claim (every column NULL — a DELETE is not available to this session; the row
--     is inert: writers filter on low_ask/highest_offer, the page 308s the key). Both halves archived.
WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
pair AS (
  SELECT a.collection_id, a.external_id AS alias_key, c.external_id AS canon_key,
         a.highest_offer, a.low_ask, a.low_ask_serial, a.low_ask_nft_id, a.low_ask_confirmed_at,
         a.best_offer_at, a.best_offer_at_amount, a.set_uuid, a.play_uuid, a.updated_at AS a_updated,
         c.updated_at AS c_updated
  FROM public.edition_offers a
  JOIN public.topshot_edition_aliases x ON x.alias_external_id = a.external_id
  JOIN public.edition_offers c ON c.collection_id = a.collection_id AND c.external_id = x.canonical_external_id
  WHERE a.collection_id = (SELECT id FROM ts)
),
arch AS (
  INSERT INTO flowty_archive.audit_20261010_175_alias_rekeys (tbl, row_key, old_value, new_value)
  SELECT 'edition_offers_merge', collection_id::text || '|' || alias_key,
         jsonb_build_object('highest_offer', highest_offer, 'low_ask', low_ask, 'low_ask_serial', low_ask_serial,
                            'low_ask_nft_id', low_ask_nft_id, 'low_ask_confirmed_at', low_ask_confirmed_at,
                            'updated_at', a_updated)::text,
         canon_key || CASE WHEN a_updated >= c_updated THEN ' (values moved)' ELSE ' (older, dropped)' END
  FROM pair
  RETURNING 1
),
moved AS (
  UPDATE public.edition_offers c
     SET highest_offer = p.highest_offer, low_ask = p.low_ask, low_ask_serial = p.low_ask_serial,
         low_ask_nft_id = p.low_ask_nft_id, low_ask_confirmed_at = p.low_ask_confirmed_at,
         best_offer_at = p.best_offer_at, best_offer_at_amount = p.best_offer_at_amount,
         set_uuid = COALESCE(c.set_uuid, p.set_uuid), play_uuid = COALESCE(c.play_uuid, p.play_uuid),
         updated_at = p.a_updated
    FROM pair p
   WHERE c.collection_id = p.collection_id AND c.external_id = p.canon_key AND p.a_updated >= p.c_updated
  RETURNING 1
)
UPDATE public.edition_offers a
   SET highest_offer = NULL, low_ask = NULL, low_ask_serial = NULL, low_ask_nft_id = NULL,
       low_ask_confirmed_at = NULL, best_offer_at = NULL, best_offer_at_amount = NULL, updated_at = now()
  FROM pair p
 WHERE a.collection_id = p.collection_id AND a.external_id = p.alias_key;

-- Verify (read after apply):
--   select count(*) from topshot_atlas_edition_map where external_id ~ '^149:[0-9]+::8$';   -- 0
--   select count(*) from topshot_atlas_edition_map where external_id ~ '^152:[0-9]+$';      -- 25
--   select count(*) from edition_offers where external_id ~ '^149:[0-9]+::8$' and (low_ask is not null or highest_offer is not null);  -- 0
