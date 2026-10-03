-- DB invariant: public.get_topshot_issuer_held_split_edition — one Top Shot
-- edition's issuer-held split for the edition page's market-cap tile. Pins:
--   · one row for a Top Shot external_id, ZERO rows for an unknown id or a
--     malformed one (the tile renders nothing then, never a fabricated row);
--   · NULL in_packs / reserve with a "pending:" status until every drop is read and
--     every drop with packs left is settled — never 0;
--   · once settled: in_packs counts ONLY this printing's rows (the base edition does
--     not absorb its parallel, and vice versa), only rows of each drop's CURRENT
--     pass, and reserve = hidden − in_packs; drops_with_packs counts distinct drops;
--   · a packed parallel of the same play that cannot be keyed makes the split
--     unknown; more in packs than issuer-held is "contradicted", not negative.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261003232935_audit_20261003_topshot_issuer_held_split_one_edition.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if a copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
INSERT INTO public.collections VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'), ('11111111-1111-1111-1111-111111111111', 'nfl_all_day');
CREATE TABLE public.editions (collection_id uuid, subedition_id integer, subedition_name text);
INSERT INTO public.editions VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 9, 'Bit');
CREATE TABLE public.badge_editions (collection_id uuid, external_id text, tier text, hidden_in_packs integer, updated_at timestamptz);
INSERT INTO public.badge_editions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '261:8705',    'COMMON', 50, now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '261:8705::9', 'RARE',   6,  now()),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '261:9999',    'COMMON', 20, now()),
  ('11111111-1111-1111-1111-111111111111', '261:8705',    'COMMON', 99, now());

CREATE TABLE public.topshot_atlas_pack_state (id integer PRIMARY KEY, list_started_at timestamptz, list_next_offset integer, list_total integer, list_done_at timestamptz);
INSERT INTO public.topshot_atlas_pack_state VALUES (1, now() - interval '1 hour', 300, 3, NULL);
CREATE TABLE public.topshot_atlas_dists (dist_id text PRIMARY KEY, summary_fetched_at timestamptz, remaining_total bigint,
  editions_pass bigint, editions_done_at timestamptz, edition_remaining_sum bigint);
INSERT INTO public.topshot_atlas_dists VALUES
  ('8617', now(), 7, 1, now(), 7),
  ('8700', now(), 2, 2, now(), 2),
  ('100',  now(), 0, 3, now(), 0);
CREATE TABLE public.topshot_atlas_dist_editions (dist_id text, atlas_edition_id text, pass bigint, set_id integer, play_id integer,
  parallel text, tier text, original_count bigint, remaining_count bigint, hidden_at_fetch bigint, fetched_at timestamptz);
INSERT INTO public.topshot_atlas_dist_editions VALUES
  ('8617', 'a', 1, 261, 8705, 'Standard', 'COMMON', 10, 4, 50, now()),
  ('8617', 'b', 1, 261, 8705, 'Bit',      'RARE',   3,  3, 6,  now()),
  ('8700', 'c', 2, 261, 8705, 'Standard', 'COMMON', 5,  2, 50, now()),
  ('100',  'd', 0, 261, 8705, 'Standard', 'COMMON', 9,  9, 50, now()),   -- a superseded pass: never read
  ('8617', 'e', 1, 261, 9999, 'Standard', 'COMMON', 1,  0, 20, now());   -- opened out: not "in packs"

-- >>> BEGIN verbatim get_topshot_issuer_held_split_edition (keep byte-identical to the migration) >>>
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
-- <<< END verbatim get_topshot_issuer_held_split_edition <<<

SELECT _assert_eq((SELECT count(*)::text FROM get_topshot_issuer_held_split_edition('nope')), '0', 'an unknown id: zero rows');
SELECT _assert_eq((SELECT count(*)::text FROM get_topshot_issuer_held_split_edition('261:8705;drop')), '0', 'a malformed id: zero rows');
SELECT _assert_eq((SELECT count(*)::text FROM get_topshot_issuer_held_split_edition('261:8705')), '1', 'a Top Shot edition: exactly one row (the All Day row with the same key is not read)');

-- The list is still incomplete: pending, NULL, never 0.
SELECT _assert((SELECT in_packs IS NULL AND reserve IS NULL AND drops_with_packs IS NULL AND split_status LIKE 'pending:%' AND hidden = 50
                  FROM get_topshot_issuer_held_split_edition('261:8705')), 'pending: NULL split, hidden still shown');

UPDATE public.topshot_atlas_pack_state SET list_done_at = now();
SELECT _assert_eq((SELECT in_packs || '/' || reserve || '/' || drops_with_packs || '/' || split_status FROM get_topshot_issuer_held_split_edition('261:8705')),
  '6/44/2/ok', 'base printing: 4 + 2 from the current passes only, its parallel and the superseded pass excluded');
SELECT _assert_eq((SELECT in_packs || '/' || reserve || '/' || drops_with_packs FROM get_topshot_issuer_held_split_edition('261:8705::9')),
  '3/3/1', 'the parallel counts only its own rows');
SELECT _assert_eq((SELECT in_packs || '/' || reserve || '/' || drops_with_packs FROM get_topshot_issuer_held_split_edition('261:9999')),
  '0/20/0', 'an edition in no unopened pack is all reserve');

-- A drop with packs left that does not reconcile holds the split.
UPDATE public.topshot_atlas_dists SET edition_remaining_sum = 6 WHERE dist_id = '8617';
SELECT _assert((SELECT in_packs IS NULL AND split_status LIKE 'pending:%' FROM get_topshot_issuer_held_split_edition('261:8705')),
  'an unreconciled drop: pending');
UPDATE public.topshot_atlas_dists SET edition_remaining_sum = 7 WHERE dist_id = '8617';

-- An unkeyable parallel of the same play makes it unknown.
INSERT INTO public.topshot_atlas_dist_editions VALUES ('8617', 'f', 1, 261, 8705, 'Mystery', 'RARE', 1, 1, 1, now());
SELECT _assert((SELECT in_packs IS NULL AND split_status LIKE 'unknown:%' FROM get_topshot_issuer_held_split_edition('261:8705')),
  'an unkeyable packed parallel of this play: unknown, not dropped');
UPDATE public.topshot_atlas_dist_editions SET remaining_count = 0 WHERE atlas_edition_id = 'f';

-- More in packs than issuer-held: contradicted, never negative.
UPDATE public.badge_editions SET hidden_in_packs = 5 WHERE external_id = '261:8705' AND tier = 'COMMON' AND hidden_in_packs = 50;
SELECT _assert((SELECT reserve IS NULL AND split_status LIKE 'contradicted:%' FROM get_topshot_issuer_held_split_edition('261:8705')),
  'contradicted, not a negative reserve');

SELECT '✓ get_topshot_issuer_held_split_edition: all assertions passed' AS result;

ROLLBACK;
