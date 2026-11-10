-- anon-exec: unchanged (sentinel_edition_coverage) — CREATE OR REPLACE of an existing fn; ACL preserved (service_role + postgres only), read from proacl 2026-11-09 before this write.
-- 2026-11-09 ~11:24 PM PT (Cowork cloud; Trevor: "Make your own decisions based upon what you know,
-- what's best for RPC long term, and for our users" — the Candy coverage question from the audit pass).
--
-- WHY. The Sentinel's Edition Coverage arm read 74.3 % (WARN under 90) since the 11-08 Candy scope
-- decision catalogued every legacy Candy collection: the census created ~21.7k editions, and the FMV
-- writer prices a Candy edition only once it has a sale (fmv_backfill_candidates). Every other
-- collection read 100 %. A permanently-red arm cannot report the regression it exists for (an edition
-- the writer SHOULD have reached and did not), and lowering the threshold would hide one.
--
-- WHAT. A third scope, `candy_legacy_catalog`: Candy editions whose set is a census-created legacy
-- collection (sets.external_id LIKE 'candy-coll-%'). It is keyed on the SET, never on "has no price"
-- (that would be circular and could not fail). Both numbers are returned and the Sentinel prints the
-- legacy count beside the headline, so nothing is dropped from view.
--
-- NOT DONE, measured: scoping by "never had a sale" (NOT EXISTS over sales) cost 464,805 buffers and
-- 34.7 s for the 21,736 probes — the probe would have been the load (the 09-13 lesson this function's
-- own header records). The set-keyed form adds one hashed subplan over `sets` (111 buffers).
--
-- Preview at write time: live 65,311 / 65,661 (99.5 %); candy_legacy_catalog 1 / 21,736.
-- Base body md5 5249f3ae… matched to live prosrc before this write.
-- Revert: re-apply the body from 20260913155500 (drops the candy_legacy_catalog arm).
CREATE OR REPLACE FUNCTION public.sentinel_edition_coverage()
 RETURNS TABLE(scope text, editions bigint, with_fmv bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH classified AS (
    SELECT
      e.id,
      CASE
        WHEN e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
             AND e.external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
        THEN 'inert_ts_uuid'
        -- 2026-11-09: a legacy Candy collection catalogued by the census (11-08). Keyed on the SET.
        WHEN e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
             AND e.set_id IN (SELECT st.id FROM public.sets st
                               WHERE st.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
                                 AND st.external_id LIKE 'candy-coll-%')
        THEN 'candy_legacy_catalog'
        ELSE 'live'
      END AS scope
    FROM public.editions e
  )
  SELECT
    c.scope,
    count(*)::bigint                                                   AS editions,
    -- edition_fmv_current holds one row per edition that has EVER had a snapshot
    -- (refreshed hourly; a lower bound — see the migration header). Existence is
    -- the only thing read here, so the stale-copy caveat on its VALUE columns
    -- (never display a price from it) does not apply.
    count(*) FILTER (WHERE fc.edition_id IS NOT NULL)::bigint          AS with_fmv
  FROM classified c
  LEFT JOIN public.edition_fmv_current fc ON fc.edition_id = c.id
  GROUP BY c.scope;
$function$;
