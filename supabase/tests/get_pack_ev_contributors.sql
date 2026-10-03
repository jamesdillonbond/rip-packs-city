-- DB invariant: public.get_pack_ev_contributors — the top editions of a Top
-- Shot dist by EV contribution (pack-dist page, "What drives the remaining EV").
-- Added 2026-10-02 with the LATERAL rewrite. Claims:
--
--   1. Each pool edition is priced from its LATEST Top Shot fmv_snapshots row
--      (a newer row in ANOTHER collection with the same edition_id is ignored).
--   2. An edition with no snapshot is listed with NULL fmv and contributes 0.
--   3. Zero-weight pool rows and other dists are excluded.
--   4. pull_prob / ev_per_slot / pct_of_ev are over the whole pool; rows are
--      ordered by drop_weight * fmv DESC and cut at p_limit.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261003031302_audit_20261002_pack_ev_contributors_latest_fmv_by_index_probe.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pack_drop_pool (collection_id uuid, dist_id text, edition_id uuid, drop_weight numeric);
CREATE TABLE public.editions (id uuid PRIMARY KEY, external_id text, name text, player_name text, set_name text, tier text, circulation_count integer);
CREATE TABLE public.fmv_snapshots (collection_id uuid, edition_id uuid, fmv_usd numeric, confidence text, computed_at timestamptz);

-- >>> BEGIN verbatim >>>
CREATE OR REPLACE FUNCTION public.get_pack_ev_contributors(p_dist_id text, p_limit integer DEFAULT 12)
 RETURNS TABLE(edition_id uuid, external_id text, name text, player_name text, set_name text, tier text, circulation_count integer, fmv_usd numeric, confidence text, pull_prob numeric, ev_per_slot numeric, pct_of_ev numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pool AS (
    SELECT dp.edition_id, dp.drop_weight
    FROM public.pack_drop_pool dp
    WHERE dp.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND dp.dist_id = p_dist_id AND dp.drop_weight > 0
  ),
  -- 2026-10-02: each pool edition's latest snapshot by a per-edition index
  -- probe (collection_id, edition_id, computed_at DESC), not a DISTINCT ON
  -- over every snapshot of every pool edition (which sorted to temp files).
  j AS (
    SELECT p.edition_id, p.drop_weight, e.external_id, e.name, e.player_name, e.set_name,
           e.tier::text AS tier, e.circulation_count, lf.fmv_usd, lf.confidence
    FROM pool p JOIN public.editions e ON e.id = p.edition_id
    LEFT JOIN LATERAL (
      SELECT fs.fmv_usd, fs.confidence::text AS confidence
      FROM public.fmv_snapshots fs
      WHERE fs.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
        AND fs.edition_id = p.edition_id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
  ),
  tot AS ( SELECT sum(drop_weight) AS sw, sum(drop_weight*coalesce(fmv_usd,0)) AS swf FROM j )
  SELECT j.edition_id, j.external_id, j.name, j.player_name, j.set_name, j.tier,
    j.circulation_count, round(j.fmv_usd,2) AS fmv_usd, j.confidence,
    round((j.drop_weight/nullif(t.sw,0))::numeric,5) AS pull_prob,
    round((j.drop_weight/nullif(t.sw,0)*coalesce(j.fmv_usd,0))::numeric,2) AS ev_per_slot,
    round((j.drop_weight*coalesce(j.fmv_usd,0)/nullif(t.swf,0)*100)::numeric,1) AS pct_of_ev
  FROM j CROSS JOIN tot t
  ORDER BY j.drop_weight*coalesce(j.fmv_usd,0) DESC
  LIMIT p_limit;
$function$;
-- <<< END verbatim <<<

INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-00000000000a', 'A', 'Ed A', 'Player A', 'Set', 'COMMON', 100),
  ('00000000-0000-0000-0000-00000000000b', 'B', 'Ed B', 'Player B', 'Set', 'RARE', 50),
  ('00000000-0000-0000-0000-00000000000c', 'C', 'Ed C', 'Player C', 'Set', 'LEGENDARY', 10),
  ('00000000-0000-0000-0000-00000000000d', 'D', 'Ed D', 'Player D', 'Set', 'COMMON', 999);
INSERT INTO public.pack_drop_pool VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '7', '00000000-0000-0000-0000-00000000000a', 3),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '7', '00000000-0000-0000-0000-00000000000b', 1),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '7', '00000000-0000-0000-0000-00000000000c', 0),   -- zero weight: excluded
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '7', '00000000-0000-0000-0000-00000000000d', 1),   -- no snapshot
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8', '00000000-0000-0000-0000-00000000000c', 5),   -- other dist
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '7', '00000000-0000-0000-0000-00000000000c', 5);   -- other collection
INSERT INTO public.fmv_snapshots VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-00000000000a', 1.00, 'LOW',    '2026-09-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-00000000000a', 2.00, 'HIGH',   '2026-10-01'),  -- latest
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-00000000000b', 10.00, 'MEDIUM', '2026-09-15'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '00000000-0000-0000-0000-00000000000b', 999.00, 'HIGH', '2026-10-02'); -- newer, other collection

DO $$
BEGIN
  PERFORM _assert_eq((SELECT count(*)::text FROM public.get_pack_ev_contributors('7', 12)), '3',
                     'pool rows with weight > 0 in this dist and collection only (claim 3)');
  PERFORM _assert_eq((SELECT string_agg(external_id, ',' ORDER BY ord) FROM public.get_pack_ev_contributors('7', 12) WITH ORDINALITY t(edition_id, external_id, name, player_name, set_name, tier, circulation_count, fmv_usd, confidence, pull_prob, ev_per_slot, pct_of_ev, ord)),
                     'B,A,D', 'ordered by weight x fmv: B 1x10, A 3x2, D 1x0 (claim 4)');
  PERFORM _assert_eq((SELECT fmv_usd::text || '/' || confidence FROM public.get_pack_ev_contributors('7', 12) WHERE external_id = 'A'),
                     '2.00/HIGH', 'the latest snapshot prices the edition (claim 1)');
  PERFORM _assert_eq((SELECT fmv_usd::text FROM public.get_pack_ev_contributors('7', 12) WHERE external_id = 'B'),
                     '10.00', 'a newer snapshot in another collection is ignored (claim 1)');
  PERFORM _assert((SELECT fmv_usd IS NULL AND ev_per_slot = 0 AND pct_of_ev = 0 FROM public.get_pack_ev_contributors('7', 12) WHERE external_id = 'D'),
                  'no snapshot: NULL fmv, contributes 0 (claim 2)');
  PERFORM _assert_eq((SELECT pull_prob::text || '|' || ev_per_slot::text || '|' || pct_of_ev::text FROM public.get_pack_ev_contributors('7', 12) WHERE external_id = 'A'),
                     '0.60000|1.20|37.5', 'A: 3/5 of the pool, 0.6 x 2.00, 6 of 16 weighted dollars (claim 4)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.get_pack_ev_contributors('7', 2)), '2', 'cut at p_limit (claim 4)');
END $$;

ROLLBACK;
