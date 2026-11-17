-- 2026-09-29 (PT) — an inferred pull name is re-derived every run and cleared
-- when today's corpus no longer backs it.
--
-- WHY. name_pack_pulls_by_id_neighbours() only ever named NULL pulls, so a name
-- inferred from yesterday's corpus stood for ever. When the corpus gained every
-- sale-named id (20260929143000; 2.48M -> 4.17M ids), 11,492 of 11,554 inferred
-- names still agreed, but 14 now point at another edition and 47 are no longer
-- supported (a neighbour changed or dropped out as conflicting). Those must not
-- keep pricing packs.
--
-- WHAT. Guarded splice of the live body (md5 cef59d4844a20d279591333e990c59d2 = 20260929130700):
--   (0) every id_neighbours pull is re-checked; cleared (edition NULL, its pack
--       requeued to reprice) when its neighbours no longer agree within 50 ids
--       on the SAME edition, or when the id itself now has a record (the pull
--       lane's own sources then name it). Cleared pulls are named again in the
--       same run if today's corpus supports a (new) edition -- never an id a
--       record names (the pull lane names those).
--   a pull renamed to another edition requeues its pack (n_inferred alone
--   would not change).
-- anon-exec: unchanged (name_pack_pulls_by_id_neighbours) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-29).
--
-- Revert: re-apply name_pack_pulls_by_id_neighbours from
--   supabase/migrations/20260929130700_audit_20260929_topshot_pack_pulls_named_by_id_neighbours.sql
--   and repoint its pin.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.name_pack_pulls_by_id_neighbours()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'cef59d4844a20d279591333e990c59d2' AND v_md5 IS DISTINCT FROM 'b52ea2773d12f25bd4910a0fa23b464f' THEN
    RAISE EXCEPTION 'name_pack_pulls_by_id_neighbours changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.name_pack_pulls_by_id_neighbours()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cand int := 0; v_named int := 0; v_packs int := 0; v_cleared int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('name_pack_pulls_by_id_neighbours')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (0) 2026-09-29: an inference is only as good as the corpus it was drawn
  -- from. Re-derive every inferred name against today's corpus and clear the
  -- ones it no longer backs (neighbours now disagree / too far, or a record
  -- now names the id itself), so they are named again below or by a record.
  -- The corpus gaining sales moved 14 of 11,554 to another edition and left
  -- 47 unsupported.
  WITH inf AS MATERIALIZED (
    SELECT o.pack_nft_id, o.nft_id, o.nft_id::bigint AS id, e.external_id AS cur
      FROM public.pack_open_pulls o
      JOIN public.editions e ON e.id = o.edition_id
     WHERE o.collection_id = v_ts AND o.resolved_via = 'id_neighbours'
  ), chk AS (
    SELECT i.*, lo.id AS lo_id, lo.edition_external_id AS lo_ext, hi.id AS hi_id, hi.edition_external_id AS hi_ext,
           EXISTS (SELECT 1 FROM public.topshot_moment_id_editions x WHERE x.id = i.id) AS has_record
    FROM inf i
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id FROM public.topshot_moment_id_editions t
       WHERE t.id < i.id ORDER BY t.id DESC LIMIT 1
    ) lo ON true
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id FROM public.topshot_moment_id_editions t
       WHERE t.id > i.id ORDER BY t.id ASC LIMIT 1
    ) hi ON true
  ), stale AS (
    SELECT c.pack_nft_id, c.nft_id FROM chk c
     WHERE c.has_record
        OR NOT (coalesce(c.lo_ext = c.hi_ext, false)
                AND c.id - c.lo_id <= 50 AND c.hi_id - c.id <= 50
                AND c.lo_ext = c.cur)
  ), clr AS (
    UPDATE public.pack_open_pulls o
       SET edition_id = NULL, resolved_via = NULL, resolved_at = NULL, local_checked_at = NULL
      FROM stale s
     WHERE o.collection_id = v_ts AND o.pack_nft_id = s.pack_nft_id AND o.nft_id = s.nft_id
       AND o.resolved_via = 'id_neighbours'
    RETURNING o.pack_nft_id
  ), rq AS (
    UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
      FROM (SELECT DISTINCT pack_nft_id FROM clr) c
     WHERE v.collection_id = v_ts AND v.pack_nft_id = c.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_cleared FROM clr;

  SELECT count(*) INTO v_cand FROM public.pack_open_pulls
   WHERE collection_id = v_ts AND edition_id IS NULL AND nft_id ~ '^[0-9]{1,15}$';

  WITH cand AS MATERIALIZED (
    SELECT p.pack_nft_id, p.nft_id, p.nft_id::bigint AS id
    FROM public.pack_open_pulls p
    WHERE p.collection_id = v_ts AND p.edition_id IS NULL AND p.nft_id ~ '^[0-9]{1,15}$'
  ), pred AS (
    SELECT c.*, lo.id AS lo_id, lo.ext AS lo_ext, hi.id AS hi_id, hi.ext AS hi_ext
    FROM cand c
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id AS ext FROM public.topshot_moment_id_editions t
       WHERE t.id < c.id ORDER BY t.id DESC LIMIT 1
    ) lo ON true
    LEFT JOIN LATERAL (
      SELECT t.id, t.edition_external_id AS ext FROM public.topshot_moment_id_editions t
       WHERE t.id > c.id ORDER BY t.id ASC LIMIT 1
    ) hi ON true
  ), named AS (
    -- both neighbours the SAME edition, each within 50 ids (99.3 % measured);
    -- the edition must exist in our catalogue
    SELECT p.pack_nft_id, p.nft_id, e.id AS edition_id
    FROM pred p
    JOIN public.editions e ON e.collection_id = v_ts AND e.external_id = p.lo_ext
    WHERE p.lo_ext = p.hi_ext
      AND p.id - p.lo_id <= 50
      AND p.hi_id - p.id <= 50
      -- an id a record names is the pull lane's to name, never inferred
      AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_id_editions x WHERE x.id = p.id)
  ), upd AS (
    UPDATE public.pack_open_pulls o
       SET edition_id = n.edition_id, resolved_via = 'id_neighbours', resolved_at = now()
      FROM named n
     WHERE o.collection_id = v_ts AND o.pack_nft_id = n.pack_nft_id AND o.nft_id = n.nft_id
       AND o.edition_id IS NULL
    RETURNING o.pack_nft_id
  ), rq AS (
    -- a pack whose inferred name changed edition keeps the same n_inferred,
    -- so it is requeued here, not only by the count below
    UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
      FROM (SELECT DISTINCT pack_nft_id FROM upd) u
     WHERE v.collection_id = v_ts AND v.pack_nft_id = u.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_named FROM upd;

  -- every pack carrying an inferred name: keep n_inferred exact and queue a
  -- reprice where it changed
  WITH cnt AS (
    SELECT o.pack_nft_id, count(*) AS n
      FROM public.pack_open_pulls o
     WHERE o.collection_id = v_ts AND o.resolved_via = 'id_neighbours'
     GROUP BY o.pack_nft_id
  ), upd AS (
    UPDATE public.pack_open_pull_values v
       SET n_inferred = coalesce(c.n, 0), priced_at = '-infinity'
      FROM (SELECT v2.pack_nft_id, cnt.n
              FROM public.pack_open_pull_values v2
              LEFT JOIN cnt ON cnt.pack_nft_id = v2.pack_nft_id
             WHERE v2.collection_id = v_ts
               AND v2.n_inferred IS DISTINCT FROM coalesce(cnt.n, 0)) c
     WHERE v.collection_id = v_ts AND v.pack_nft_id = c.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) INTO v_packs FROM upd;

  PERFORM public.log_pipeline_run('pack-pulls-id-neighbours', v_started, v_cand, v_named, v_cand - v_named, true, NULL,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('unnamed_candidates', v_cand, 'named', v_named, 'packs_requeued', v_packs, 'inferred_cleared', v_cleared));
  RETURN jsonb_build_object('ok', true, 'unnamed_candidates', v_cand, 'named', v_named, 'packs_requeued', v_packs,
                            'inferred_cleared', v_cleared);
END;
$function$;
