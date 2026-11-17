-- AllDay per-moment jersey backfill RPC. Mirrors backfill_edition_jersey (TS,
-- keyed on play_id_onchain) but keys on external_id, since AllDay editions'
-- external_id == Atlas edition id 1:1 and they are not play_id_onchain-keyed.
-- Jersey source is the Atlas SearchEditions editionTemplate.metadata.playerNumber,
-- ingested on the residential badge path (scripts/ingest-allday-badges.mjs ->
-- /api/cron/allday-badge-ingest). Change-detecting + NULL-safe; only accepts
-- 0..99 (a valid NFL jersey; team/non-player moments carry no playerNumber).
-- Powers the jersey-match special-serial row: get_edition_special_serials reads
-- editions.jersey_number generically, so populating it lights the row up with no
-- display change.
--
-- Revert: DROP FUNCTION public.backfill_allday_edition_jersey(jsonb);
CREATE OR REPLACE FUNCTION public.backfill_allday_edition_jersey(p_pairs jsonb)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH up AS (
    UPDATE public.editions e
    SET jersey_number = v.jersey
    FROM jsonb_to_recordset(p_pairs) AS v(external_id text, jersey integer)
    WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
      AND e.external_id = v.external_id
      AND v.jersey IS NOT NULL
      AND v.jersey BETWEEN 0 AND 99
      AND e.jersey_number IS DISTINCT FROM v.jersey
    RETURNING 1
  )
  SELECT count(*)::int FROM up;
$function$;

REVOKE ALL ON FUNCTION public.backfill_allday_edition_jersey(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.backfill_allday_edition_jersey(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.backfill_allday_edition_jersey(jsonb) TO service_role;
