-- audit_20261110_pack_table_rows_live_ask_probe_is_one_key
-- definer-view: intentional — pack_table_rows was already a definer view (reloptions NULL) and is listed in
-- security_definer_view_allowlist (baseline 2026-06-28); this change keeps that mode, as 20261020055615 did.
--
-- WHY (Claude Code cloud, 2026-11-10 ~7:40 PM PT). /api/packs reads pack_table_rows (page + exact count) at ~90k
-- buffers / ~1.4 s a call (pgss). The view's `pas` LATERAL (the board's live pack ask) matched pack_ask_state with
--   dist_id = pd.dist_id AND (coll = TS AND slug = 'nba-top-shot' OR coll = AD AND slug = 'nfl-all-day' OR
--                             coll = Golazos AND slug = 'laliga-golazos')
-- and the planner turned the OR into a BitmapOr whose Golazos leg had NO dist_id -- so every board row bitmap-read the
-- whole Golazos ask slice (24k of 58k buffers on a Top Shot page). The same condition as ONE key:
--   dist_id = pd.dist_id AND slug = CASE pd.collection_id WHEN TS THEN 'nba-top-shot' WHEN AD THEN 'nfl-all-day'
--                                                           WHEN Golazos THEN 'laliga-golazos' ELSE NULL END
-- Equivalent by cases: for those three collections both forms are `slug = <that slug>`; for any other collection the
-- OR is false and `slug = NULL` is never true -- no row either way. Measured as a temp view over live data: all 6,815
-- rows identical (EXCEPT both ways = 0); the Top Shot board page 57,948 -> 27,968 buffers, 309 -> 97 ms.
--
-- HOW. The view is ~14k chars and unpinned; it is rewritten from its LIVE definition with exactly this one fragment
-- replaced: the DO block asserts the live md5 (pg_get_viewdef(..., true) = ca270315...), that the fragment occurs
-- exactly once, and that the result differs. reloptions: none before (no security_invoker), none after; CREATE OR
-- REPLACE keeps the ACL (anon/authenticated have no SELECT); no dependent views.
--
-- REVERT: the same DO block with old/new swapped (guard md5 = the post-change definition).

DO $$
DECLARE
  d text := pg_get_viewdef('public.pack_table_rows'::regclass, true);
  o text := $o$WHERE pas0.dist_id = pd.dist_id AND (pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND pas0.collection_slug = 'nba-top-shot'::text OR pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND pas0.collection_slug = 'nfl-all-day'::text OR pd.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid AND pas0.collection_slug = 'laliga-golazos'::text)$o$;
  nw text := $n$WHERE pas0.dist_id = pd.dist_id AND pas0.collection_slug = CASE pd.collection_id WHEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN 'nba-top-shot'::text WHEN 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN 'nfl-all-day'::text WHEN '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid THEN 'laliga-golazos'::text ELSE NULL::text END$n$;
  n int;
BEGIN
  IF md5(d) <> 'ca270315d6839d88615d63bbb9a991fe' THEN
    RAISE EXCEPTION 'pack_table_rows drifted from the 7:40 PM PT 11-10 definition (md5 %); re-derive before replacing', md5(d);
  END IF;
  n := (length(d) - length(replace(d, o, ''))) / length(o);
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected the pas fragment exactly once, found %', n;
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.pack_table_rows AS ' || replace(d, o, nw);
  -- Postgres re-renders the CASE on read-back, so assert the OLD fragment is gone (format-independent).
  IF position(o in pg_get_viewdef('public.pack_table_rows'::regclass, true)) > 0 THEN
    RAISE EXCEPTION 'pack_table_rows was not rewritten';
  END IF;
END $$;
