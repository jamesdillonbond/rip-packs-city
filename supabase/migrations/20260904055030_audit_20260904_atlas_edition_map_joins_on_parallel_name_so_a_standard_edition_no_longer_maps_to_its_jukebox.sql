-- audit_20260904_atlas_edition_map_joins_on_parallel_name_so_a_standard_edition_no_longer_maps_to_its_jukebox
-- Applied to prod via MCP apply_migration 2026-09-04 05:50Z (version 20260904055030).
--
-- FINDING (2026-09-04, the 200-Moment RPC-vs-Top-Shot audit): `topshot_atlas_edition_map` — the
-- RPC-edition ↔ Dapper-Atlas-editionId map the Underpriced-#1s / First-Mint-Trophies ingest uses to
-- TARGET an edition's #1 and perfect-serial listing — joined on (set_id_onchain, play_id_onchain)
-- only, then `DISTINCT ON (e.id) ORDER BY e.id`. Under parallels the Standard edition and every one
-- of its parallels (Jukebox, Hexwave, …) share (set, play), so each RPC edition received an
-- ARBITRARY Atlas printing. Atlas 12703 — the row mapped to Sabonis 227:7574 (Standard, 284) — is
-- the Jukebox /10 printing. MEASURED: 1,497 of 9,080 mapped rows carry an Atlas num_minted smaller
-- than the RPC edition's circulation; 44 of 274 ACTIVE rows on the board are a parallel's #1 or
-- perfect serial priced against the Standard's FMV (245:8606 #1 "asks $25,000 vs $164 FMV" is a
-- 1-of-1 parallel). The map was also built once (2026-06-17) and never refreshed.
--
-- FIX: the runner (scripts/backfill-atlas-edition-map.mjs) now forwards Atlas `parallel`; the map
-- stores it; the join adds COALESCE(editions.subedition_name,'Standard') = parallel. A legacy row
-- with no parallel still joins, but the largest printing wins (the Standard, in practice) instead
-- of the arbitrary one. Same signature → CREATE OR REPLACE keeps the acl; re-read after apply:
-- {postgres=X/postgres,service_role=X/postgres}, one overload, check_secdef_anon_execute_violations() = 0.
-- anon-exec: no — upsert_topshot_atlas_edition_map stays postgres/service_role only (a writer);
--   REVOKE … FROM PUBLIC, anon, authenticated re-stated below.
--
-- REVERT: the previous body is the last migration defining upsert_topshot_atlas_edition_map before
--   this version (`git log -S upsert_topshot_atlas_edition_map -- supabase/migrations`); the column
--   is additive (`ALTER TABLE … DROP COLUMN parallel` if it must go). The re-mapped rows are data;
--   `mapped_at` tells old from new.

ALTER TABLE public.topshot_atlas_edition_map ADD COLUMN IF NOT EXISTS parallel text;

CREATE OR REPLACE FUNCTION public.upsert_topshot_atlas_edition_map(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
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
  joined AS (
    SELECT DISTINCT ON (e.id)
      e.id AS rpc_edition_id, e.external_id,
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
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_topshot_atlas_edition_map(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_topshot_atlas_edition_map(jsonb) TO postgres, service_role;
