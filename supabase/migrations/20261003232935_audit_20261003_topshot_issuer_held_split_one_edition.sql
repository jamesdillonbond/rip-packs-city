-- audit_20261003_topshot_issuer_held_split_one_edition
--
-- One Top Shot edition's issuer-held split (inside unopened packs vs reserve never
-- packed), for the market-cap tile on the edition page. Same gate and same keying
-- as topshot_issuer_held_split_editions() (20261003224608), but reads only that
-- edition's rows: the bulk reader is SECURITY DEFINER, so Postgres never inlines
-- it, and filtering its output would aggregate every edition on every page view.
--
-- Returns exactly one row for a Top Shot badge_editions external_id, zero rows for
-- anything else (the tile renders nothing then). in_packs / reserve are NULL with a
-- status until the split is provable — never 0.
--
-- anon-exec: revoked (get_topshot_issuer_held_split_edition) — new fn; service_role reader.
--
-- Revert: DROP FUNCTION public.get_topshot_issuer_held_split_edition(text);
--         DROP INDEX public.topshot_atlas_dist_editions_set_play_idx;

CREATE INDEX IF NOT EXISTS topshot_atlas_dist_editions_set_play_idx
  ON public.topshot_atlas_dist_editions (set_id, play_id);

CREATE OR REPLACE FUNCTION public.get_topshot_issuer_held_split_edition(p_external_id text)
 RETURNS TABLE(edition_external_id text, hidden bigint, in_packs bigint, reserve bigint,
               drops_with_packs integer, split_status text, as_of timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
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
      (SELECT list_done_at IS NOT NULL AND list_started_at > now() - interval '48 hours'
         FROM public.topshot_atlas_pack_state WHERE id = 1)                                   AS list_ok,
      count(*) FILTER (WHERE d.summary_fetched_at IS NULL)                                     AS never_read,
      count(*) FILTER (WHERE d.remaining_total > 0
                         AND (d.summary_fetched_at < now() - interval '48 hours'
                              OR d.editions_done_at IS NULL
                              OR d.edition_remaining_sum IS DISTINCT FROM d.remaining_total)) AS open_unsettled,
      min(d.summary_fetched_at) FILTER (WHERE d.remaining_total > 0)                           AS as_of
    FROM public.topshot_atlas_dists d
  ),
  submap AS (
    SELECT DISTINCT ON (e.subedition_name) e.subedition_name AS name, e.subedition_id AS id
      FROM public.editions e, ts
     WHERE e.collection_id = ts.id AND e.subedition_id IS NOT NULL AND e.subedition_name IS NOT NULL
     ORDER BY e.subedition_name, e.subedition_id
  ),
  rows_ AS (
    SELECT x.dist_id, x.remaining_count, x.parallel, sm.id AS sub_id
      FROM b
      JOIN public.topshot_atlas_dist_editions x ON x.set_id = b.set_id AND x.play_id = b.play_id
      JOIN public.topshot_atlas_dists d ON d.dist_id = x.dist_id AND d.editions_pass = x.pass
      LEFT JOIN submap sm ON sm.name = x.parallel
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

REVOKE ALL ON FUNCTION public.get_topshot_issuer_held_split_edition(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_issuer_held_split_edition(text) TO service_role;
