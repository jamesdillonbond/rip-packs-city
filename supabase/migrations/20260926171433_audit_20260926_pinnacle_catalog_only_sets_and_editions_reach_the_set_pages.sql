-- audit_20260926_pinnacle_catalog_only_sets_and_editions_reach_the_set_pages
--
-- WHY. Five Pinnacle sets that are live in pinnacle_catalog (the render-grain
-- table Market and the set-page grid read) had no /disney-pinnacle/set/<slug>
-- page, because a set's IDENTITY row comes from sets_summary, which only sees
-- pinnacle_editions (via editions_unified). Measured 2026-09-26, four causes:
--   * 4 legacy keys exist only in the catalog (e.g. WDAS-GEN-DPIN:Genesis:1 —
--     Disney Genesis): every pinnacle_editions writer walks wallet holdings
--     (wallet_moments_cache / pinnacle_nft_map), so a key no tracked wallet
--     holds never gets a row.
--   * 1 key is an 'Unknown' stub (PAS-LEEV2-FIND:Radiant Chrome:1 — Finding
--     Nemo Vol.2), written by backfill_missing_pinnacle_editions and never
--     repaired because no tracked wallet holds it.
--   * Star Wars Holiday Vol.2 shares royalty code SWHL with Vol.1, so its legacy
--     keys ARE Vol.1's rows. The set-level key cannot represent both sets — no
--     pinnacle_editions fix can; only a catalog-grain source can.
--   * "Star Wars Genesis" (catalog) vs "Star Wars Pinnacle Genesis" (editions):
--     two spellings, two slugs.
--
-- WHAT.
--   A. public.pinnacle_editions_fill_from_catalog(): (1) inserts a
--      pinnacle_editions row for every catalog legacy key that has none, from
--      the catalog's own fields; (2) fills the 'Unknown' fields of stub rows from
--      the catalog. Only fields that are 'Unknown' are touched; a real value is
--      never overwritten. Scheduled daily 07:43 UTC, seven minutes before
--      rpc-refresh-sets-summary (07:50), and run once here.
--      ⚠ A legacy key is SET-level and may span several characters; like every
--      existing row, the row names ONE — the key's lowest render_id, so the
--      choice is stable. mint_count is written only when every render under the
--      key agrees, else NULL (never a guess at a key-level count).
--   B. sets_summary gains a Pinnacle branch from pinnacle_catalog for any set
--      whose trimmed slug no pinnacle_editions set name produces. The existing
--      branch is unchanged, so every existing slug keeps resolving and no set is
--      counted from two sources. get_set_detail / get_set_editions already read
--      the catalog by set_name_variants for Pinnacle, so the new rows render
--      real stats and a real grid with no function change.
--      Rebuilt inside this migration's transaction: readers keep the old MV
--      until COMMIT, then see the new, already-populated one.
--
-- REVERT: SELECT cron.unschedule('rpc-pinnacle-editions-fill-from-catalog');
--   DROP FUNCTION public.pinnacle_editions_fill_from_catalog();
--   re-create sets_summary from 20260903064122 (DROP + that CREATE without
--   IF NOT EXISTS / WITH NO DATA + its 3 indexes + GRANT service_role);
--   rows the fill inserted can be removed by id (4 at apply time).

-- ─── A. The catalog fill ──────────────────────────────────────────────────

-- anon-exec: intentional — pinnacle_editions_fill_from_catalog is REVOKEd below from PUBLIC, anon, authenticated; pg_cron (postgres) and service_role only.
CREATE OR REPLACE FUNCTION public.pinnacle_editions_fill_from_catalog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
  v_repaired integer;
BEGIN
  WITH rep AS (
    SELECT DISTINCT ON (pc.legacy_edition_key)
      pc.legacy_edition_key                      AS k,
      NULLIF(btrim(pc.characters[1]), '')        AS character_name,
      NULLIF(btrim(pc.franchises[1]), '')        AS franchise,
      NULLIF(btrim(pc.set_name), '')             AS set_name,
      pc.royalty_code,
      pc.variant,
      pc.edition_type,
      pc.printing,
      pc.limited_edition,
      pc.is_chaser,
      CASE WHEN pc.series_name ~ '^[0-9]{4}$' THEN pc.series_name::int END AS series_year
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    ORDER BY pc.legacy_edition_key, pc.render_id
  ),
  minted AS (
    SELECT pc.legacy_edition_key AS k,
           CASE WHEN count(DISTINCT pc.total_minted) = 1 AND count(pc.total_minted) = count(*)
                THEN min(pc.total_minted) END AS mint_count
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    GROUP BY pc.legacy_edition_key
  )
  INSERT INTO public.pinnacle_editions (
    id, edition_key, character_name, franchise, set_name, royalty_code,
    series_year, variant_type, edition_type, printing, mint_count,
    is_serialized, is_chaser
  )
  SELECT r.k, r.k, r.character_name, COALESCE(r.franchise, 'Unknown'), r.set_name,
         r.royalty_code, r.series_year, COALESCE(r.variant, 'Standard'),
         COALESCE(r.edition_type, 'Open Edition'), COALESCE(r.printing, 1),
         m.mint_count, COALESCE(r.limited_edition, false), COALESCE(r.is_chaser, false)
  FROM rep r
  JOIN minted m ON m.k = r.k
  WHERE r.character_name IS NOT NULL
    AND r.set_name IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.pinnacle_editions pe WHERE pe.id = r.k)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  WITH rep AS (
    SELECT DISTINCT ON (pc.legacy_edition_key)
      pc.legacy_edition_key               AS k,
      NULLIF(btrim(pc.characters[1]), '') AS character_name,
      NULLIF(btrim(pc.franchises[1]), '') AS franchise,
      NULLIF(btrim(pc.set_name), '')      AS set_name
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    ORDER BY pc.legacy_edition_key, pc.render_id
  )
  UPDATE public.pinnacle_editions pe
     SET character_name = CASE WHEN pe.character_name = 'Unknown' AND r.character_name IS NOT NULL THEN r.character_name ELSE pe.character_name END,
         franchise      = CASE WHEN pe.franchise      = 'Unknown' AND r.franchise      IS NOT NULL THEN r.franchise      ELSE pe.franchise      END,
         set_name       = CASE WHEN pe.set_name       = 'Unknown' AND r.set_name       IS NOT NULL THEN r.set_name       ELSE pe.set_name       END,
         updated_at     = now()
    FROM rep r
   WHERE r.k = pe.id
     AND (   (pe.character_name = 'Unknown' AND r.character_name IS NOT NULL)
          OR (pe.franchise      = 'Unknown' AND r.franchise      IS NOT NULL)
          OR (pe.set_name       = 'Unknown' AND r.set_name       IS NOT NULL));
  GET DIAGNOSTICS v_repaired = ROW_COUNT;

  RETURN jsonb_build_object('inserted', v_inserted, 'repaired', v_repaired);
END;
$function$;

COMMENT ON FUNCTION public.pinnacle_editions_fill_from_catalog() IS
  'Writes pinnacle_editions rows for catalog legacy keys no wallet-walking lane reached, and fills Unknown stub fields from the catalog (never overwrites a real value). pg_cron rpc-pinnacle-editions-fill-from-catalog 07:43 UTC. Migration audit_20260926_pinnacle_catalog_only_sets_and_editions_reach_the_set_pages.';

REVOKE EXECUTE ON FUNCTION public.pinnacle_editions_fill_from_catalog()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pinnacle_editions_fill_from_catalog()
  TO postgres, service_role;

SELECT public.pinnacle_editions_fill_from_catalog();

SELECT cron.schedule('rpc-pinnacle-editions-fill-from-catalog', '43 7 * * *',
  'SELECT public.pinnacle_editions_fill_from_catalog();');

-- ─── B. sets_summary sees catalog-only Pinnacle sets ──────────────────────

DROP MATERIALIZED VIEW public.sets_summary;

CREATE MATERIALIZED VIEW public.sets_summary AS
WITH slug_grouped AS (
  SELECT editions_unified.collection_id,
         regexp_replace(lower(editions_unified.set_name), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
         editions_unified.set_name,
         editions_unified.circulation_count,
         editions_unified.tier,
         editions_unified.series_num,
         editions_unified.first_minted_at,
         editions_unified.updated_at
  FROM editions_unified
  WHERE editions_unified.set_name IS NOT NULL
    AND (editions_unified.set_name <> ALL (ARRAY['Unknown'::text, ''::text]))
  UNION ALL
  -- Pinnacle sets that exist ONLY at catalog grain (see header). Trimmed name,
  -- so the slug matches the one the site links (slugifyName trims).
  SELECT '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid AS collection_id,
         regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text) AS set_slug,
         btrim(pc.set_name) AS set_name,
         pc.total_minted AS circulation_count,
         pc.variant AS tier,
         CASE WHEN pc.series_name ~ '^[0-9]{4}$' THEN pc.series_name::smallint END AS series_num,
         NULL::timestamptz AS first_minted_at,
         pc.updated_at
  FROM pinnacle_catalog pc
  WHERE pc.set_name IS NOT NULL
    AND btrim(pc.set_name) <> ALL (ARRAY['Unknown'::text, ''::text])
    AND NOT EXISTS (
      SELECT 1 FROM pinnacle_editions pe
      WHERE pe.set_name IS NOT NULL
        AND regexp_replace(lower(btrim(pe.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text)
          = regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+'::text, '-'::text, 'g'::text)
    )
)
SELECT collection_id,
       set_slug,
       (array_agg(set_name ORDER BY slug_grouped.set_name))[1] AS set_name,
       array_agg(DISTINCT set_name) AS set_name_variants,
       count(*) AS edition_count,
       sum(circulation_count) FILTER (WHERE circulation_count IS NOT NULL) AS total_circulation,
       array_agg(DISTINCT tier) FILTER (WHERE tier IS NOT NULL) AS tiers_present,
       min(series_num) AS min_series,
       max(series_num) AS max_series,
       min(first_minted_at) AS first_minted_at,
       max(updated_at) AS last_updated_at,
       now() AS computed_at
FROM slug_grouped
GROUP BY collection_id, set_slug;

CREATE UNIQUE INDEX idx_sets_summary_pk ON public.sets_summary USING btree (collection_id, set_slug);
CREATE INDEX idx_sets_summary_collection ON public.sets_summary USING btree (collection_id);
CREATE INDEX idx_sets_summary_set_name ON public.sets_summary USING btree (collection_id, set_name);

REVOKE ALL ON public.sets_summary FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sets_summary TO service_role;
