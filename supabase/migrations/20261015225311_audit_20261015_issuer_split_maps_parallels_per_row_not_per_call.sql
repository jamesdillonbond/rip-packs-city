-- 2026-10-15 (Claude Code cloud). get_topshot_issuer_held_split_edition: look up a packed parallel's
-- subedition id per row instead of building the whole name -> id map on every call.
--
-- WHY. The Top Shot edition page's market-cap tile calls this per view: 77,632 calls at 33 ms / 2,303 blocks
-- each (pg_stat_statements, 10-15). Its `submap` CTE built a DISTINCT ON (subedition_name) map from every
-- Top Shot edition carrying a parallel — 4,787 rows, 2,216 buffers, ~15 ms — to produce 21 names, of which
-- each call needs the few in this play's pack rows. Now a LATERAL per row takes the lowest subedition_id for
-- that name, served by the new idx_editions_coll_subname_subid (collection_id, subedition_name,
-- subedition_id) WHERE subedition_id IS NOT NULL AND subedition_name IS NOT NULL (built CONCURRENTLY first,
-- 56 kB; recorded below, replay-safe).
--
-- EQUIVALENCE. DISTINCT ON (name) ORDER BY name, id keeps the LOWEST id per name; the LATERAL returns the
-- lowest id for x.parallel; a NULL / unmatched parallel yields no row in both (LEFT JOIN). Compared directly
-- for every parallel name in topshot_atlas_dist_editions (23: 20 mapped, 3 unmapped incl. 'Standard'):
-- 0 differences. ⚠ An old-vs-new comparison of the function's OUTPUT over 240 editions was VACUOUS (every
-- edition currently reads "pending: 1 distribution(s) with packs left not settled", so the mapping never
-- reaches the output) and is not counted as evidence. The pin's DB test (supabase/tests/<fn>.sql) exercises
-- the settled path incl. an unkeyable parallel: green on the old body, green on the new, RED with the
-- mapping broken (planted defect).
--
-- Only the submap CTE and its join change; the rest of the body is byte-identical to the live one
-- (md5 405f80dc2a2e7a7df9b47c7cdb386892).
-- anon-exec: intentional — same signature, ACL unchanged (postgres, service_role) (get_topshot_issuer_held_split_edition)
-- REVERT: re-apply the get_topshot_issuer_held_split_edition body of
--   20261015001336_audit_20261014_issuer_held_split_survives_the_daily_list_rewalk.sql
--   (and DROP INDEX public.idx_editions_coll_subname_subid; if unwanted).
CREATE INDEX IF NOT EXISTS idx_editions_coll_subname_subid
  ON public.editions (collection_id, subedition_name, subedition_id)
  WHERE subedition_id IS NOT NULL AND subedition_name IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_topshot_issuer_held_split_edition(p_external_id text)
 RETURNS TABLE(edition_external_id text, hidden bigint, in_packs bigint, reserve bigint, drops_with_packs integer, split_status text, as_of timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH ts AS (SELECT id FROM public.collections WHERE slug = 'nba_top_shot'),
  b AS (
    SELECT be.external_id, be.hidden_in_packs, be.updated_at,
           nullif(split_part(be.external_id, ':', 1), '')::integer AS set_id,
           nullif(split_part(be.external_id, ':', 2), '')::integer AS play_id,
           nullif(split_part(be.external_id, '::', 2), '')::integer AS sub_id
      FROM public.badge_editions be, ts
     WHERE be.collection_id = ts.id AND be.external_id = p_external_id
       AND be.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
  ),
  gate AS (
    SELECT
      (SELECT list_done_at > now() - interval '48 hours'
         FROM public.topshot_atlas_pack_state WHERE id = 1)                                   AS list_ok,
      count(*) FILTER (WHERE d.summary_fetched_at IS NULL)                                     AS never_read,
      count(*) FILTER (WHERE d.remaining_total > 0
                         AND (d.summary_fetched_at < now() - interval '48 hours'
                              OR d.editions_done_at IS NULL
                              OR d.edition_remaining_sum IS DISTINCT FROM d.remaining_total)) AS open_unsettled,
      min(d.summary_fetched_at) FILTER (WHERE d.remaining_total > 0)                           AS as_of
    FROM public.topshot_atlas_dists d
  ),
  rows_ AS (
    SELECT x.dist_id, x.remaining_count, x.parallel, sm.id AS sub_id
      FROM b
      JOIN public.topshot_atlas_dist_editions x ON x.set_id = b.set_id AND x.play_id = b.play_id
      JOIN public.topshot_atlas_dists d ON d.dist_id = x.dist_id AND d.editions_pass = x.pass
      -- 2026-10-15: the parallel name -> subedition_id map is looked up per row
      -- (lowest id for the name, which is what the old DISTINCT ON map held)
      -- instead of being built from every Top Shot edition on every call.
      LEFT JOIN LATERAL (
        SELECT e.subedition_id AS id
          FROM public.editions e, ts
         WHERE e.collection_id = ts.id AND e.subedition_name = x.parallel
           AND e.subedition_id IS NOT NULL
         ORDER BY e.subedition_id
         LIMIT 1
      ) sm ON true
     WHERE x.remaining_count > 0
  ),
  -- Only this printing's rows count; a packed parallel of the same play that cannot
  -- be keyed MIGHT be this printing, so it makes the split unknown rather than
  -- being silently dropped or added.
  packed AS (
    SELECT sum(r.remaining_count) FILTER (WHERE (b.sub_id IS NULL AND r.parallel = 'Standard')
                                             OR (b.sub_id IS NOT NULL AND r.sub_id = b.sub_id))::bigint AS in_packs,
           count(DISTINCT r.dist_id) FILTER (WHERE (b.sub_id IS NULL AND r.parallel = 'Standard')
                                                OR (b.sub_id IS NOT NULL AND r.sub_id = b.sub_id))::integer AS drops,
           bool_or(r.parallel <> 'Standard' AND r.sub_id IS NULL) AS unmapped
      FROM rows_ r, b
  )
  SELECT b.external_id, b.hidden_in_packs::bigint,
         CASE WHEN st.status = 'ok' THEN coalesce(p.in_packs, 0) END,
         CASE WHEN st.status = 'ok' THEN b.hidden_in_packs - coalesce(p.in_packs, 0) END,
         CASE WHEN st.status = 'ok' THEN coalesce(p.drops, 0) END,
         st.status, g.as_of
    FROM b CROSS JOIN gate g LEFT JOIN packed p ON true
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN NOT coalesce(g.list_ok, false)        THEN 'pending: distribution list incomplete or stale'
               WHEN g.never_read > 0                      THEN 'pending: ' || g.never_read || ' distribution(s) never read'
               WHEN g.open_unsettled > 0                  THEN 'pending: ' || g.open_unsettled || ' distribution(s) with packs left not settled'
               WHEN coalesce(p.unmapped, false)           THEN 'unknown: a packed parallel of this play could not be keyed'
               WHEN b.hidden_in_packs IS NULL             THEN 'unknown: no issuer-held count'
               WHEN b.updated_at < now() - interval '36 hours' THEN 'unknown: issuer-held count is stale'
               WHEN coalesce(p.in_packs, 0) > b.hidden_in_packs THEN 'contradicted: more in packs than issuer-held'
               ELSE 'ok' END AS status
    ) st;
$function$;
