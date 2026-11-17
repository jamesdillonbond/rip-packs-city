-- UFC studio-platform sales-history enablement: per-row edition resolver + coverage
-- monitor view. UFC studio GQL has NO edition filter (set-only), so the drain
-- (app/api/cron/ufc-studio-sales-history-backfill) walks globally and resolves each
-- row's (athlete_name, edition_size) → editions.id in-process; this fn is the SQL
-- twin / spot-check tool ((lower(trim(player_name)), circulation_count) is unique
-- across our 518 UFC editions — 0 ambiguous keys). The view is a coverage monitor
-- (editions × captured_sales).
-- Applied live 2026-06-25 (audit_20260624_ufc_studio_history_resolver_and_targets);
-- this is the repo-parity copy. Revert: DROP VIEW ...; DROP FUNCTION ...
CREATE OR REPLACE FUNCTION public.resolve_ufc_edition_by_studio_meta(p_athlete text, p_edition_size bigint)
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  SELECT e.id
  FROM public.editions e
  WHERE e.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
    AND lower(btrim(e.player_name)) = lower(btrim(p_athlete))
    AND e.circulation_count = p_edition_size
  LIMIT 1
$function$;

CREATE OR REPLACE VIEW public.ufc_studio_sales_history_backfill_targets AS
 SELECT id AS edition_id,
    external_id,
    player_name,
    name,
    circulation_count,
    ( SELECT count(*) AS count
           FROM sales s
          WHERE s.edition_id = e.id) AS captured_sales
   FROM editions e
  WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid;
