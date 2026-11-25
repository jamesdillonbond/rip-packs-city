-- audit_20261125_id_neighbours_read_chain_checkpoint
--
-- Trevor 2026-11-25 7:32 AM PT: "Keep digging and probing to try and figure it out" (opened Top Shot packs with no
-- pull value). 2,316 Top Shot pack pulls (1,509 opened packs on saved wallets) had no edition: 1,503 packs were opened
-- before the mainnet27 root, which the pull-chain lane cannot read (#181), and their moments appear in no sale, listing,
-- wallet or chain read of ours -- consistent with moments burned since (trade-ins). name_pack_pulls_by_id_neighbours
-- named 1 of them: its corpus (topshot_moment_id_editions, 4.77M ids) left neighbours disagreeing on 1,962 and > 50 ids
-- away on 353.
--
-- The chain checkpoint (checkpoint_nft_meta, c='ts', 3.8M distinct Top Shot ids, ~half of them absent from the corpus)
-- closes the gap. New helper topshot_id_neighbours(id) returns the nearest known id below / above from EITHER source;
-- a checkpoint moment with no 'tssub' row is the base edition (measured: 307 of 307 known parallels carry one).
-- name_pack_pulls_by_id_neighbours' two neighbour reads now call it; its rule is unchanged (both neighbours the same
-- edition, each within 50 ids, the edition in our catalogue, labelled 'id_neighbours').
--
-- Measured before shipping:
--   * accuracy on 2,000 pulls whose edition a record names, treated as unknown: 1,748 of 1,754 named right (99.66 %;
--     the corpus-only rule measured 99.3 %). The 6 misses are base-vs-parallel.
--   * unnamed pulls it names: 794 of 2,316 (was 1).
--   * the 5,131 names it inferred before: 5,124 unchanged, 5 move to the edition the closer chain neighbours name, 2 clear.
-- The corpus table and refresh_topshot_moment_id_editions are untouched: six other lanes read it, and the daily refresh
-- runs 88-102 s under the 120 s postgres cron ceiling, so widening the corpus itself was rejected.
-- Pin: supabase/tests/name_pack_pulls_by_id_neighbours.sql K1a-c (K1a red on the old body).
--
-- anon-exec: revoked (topshot_id_neighbours) — new helper; REVOKE FROM PUBLIC, anon, authenticated below, GRANT to postgres, service_role.
-- anon-exec: unchanged (name_pack_pulls_by_id_neighbours) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false (postgres, service_role only).
-- Revert: re-apply name_pack_pulls_by_id_neighbours from 20260929145500_audit_20260929_inferred_pull_names_rederived_each_run.sql,
--   then DROP FUNCTION public.topshot_id_neighbours(bigint); names it inferred stay until the old rule's step (0) re-derives them.

DO $assert$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.name_pack_pulls_by_id_neighbours()'::regprocedure)
     NOT IN ('b52ea2773d12f25bd4910a0fa23b464f', '16c9b6bec8f21356a946f15c6d00ac8a') THEN
    RAISE EXCEPTION 'name_pack_pulls_by_id_neighbours drifted -- re-read the live body before splicing';
  END IF;
END $assert$;

CREATE OR REPLACE FUNCTION public.topshot_id_neighbours(p_id bigint)
 RETURNS TABLE(lo_id bigint, lo_ext text, hi_id bigint, hi_ext text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- The nearest Top Shot moment id below and above p_id whose edition we know, from the
  -- id->edition corpus (topshot_moment_id_editions) OR the chain checkpoint
  -- (checkpoint_nft_meta: c='ts' a=setID b=playID; c='tssub' a=subeditionID). A checkpoint
  -- moment with no 'tssub' row is the BASE edition: measured 2026-11-25, 307 of 307 known
  -- parallels carry one and no base moment lacks one but the 818 that read 0. The checkpoint
  -- holds ~2.7M Top Shot ids the corpus does not -- moments burned since (trade-ins) among
  -- them -- and halves the median neighbour gap (8 -> 4 ids) on the unnamed pulls. On a tie
  -- (the same id in both) the corpus wins.
  WITH cl AS (
    SELECT t.id, t.edition_external_id AS ext FROM public.topshot_moment_id_editions t
     WHERE t.id < p_id ORDER BY t.id DESC LIMIT 1
  ), ch AS (
    SELECT t.id, t.edition_external_id AS ext FROM public.topshot_moment_id_editions t
     WHERE t.id > p_id ORDER BY t.id ASC LIMIT 1
  ), kl AS (
    SELECT k.nft_id AS id,
           k.a || ':' || k.b || coalesce('::' || nullif((SELECT x.a FROM public.checkpoint_nft_meta x
                                                         WHERE x.c = 'tssub' AND x.nft_id = k.nft_id
                                                         ORDER BY x.spork DESC LIMIT 1), 0), '') AS ext
      FROM public.checkpoint_nft_meta k
     WHERE k.c = 'ts' AND k.nft_id < p_id ORDER BY k.nft_id DESC LIMIT 1
  ), kh AS (
    SELECT k.nft_id AS id,
           k.a || ':' || k.b || coalesce('::' || nullif((SELECT x.a FROM public.checkpoint_nft_meta x
                                                         WHERE x.c = 'tssub' AND x.nft_id = k.nft_id
                                                         ORDER BY x.spork DESC LIMIT 1), 0), '') AS ext
      FROM public.checkpoint_nft_meta k
     WHERE k.c = 'ts' AND k.nft_id > p_id ORDER BY k.nft_id ASC LIMIT 1
  )
  SELECT CASE WHEN kl.id > coalesce(cl.id, -1) THEN kl.id ELSE cl.id END,
         CASE WHEN kl.id > coalesce(cl.id, -1) THEN kl.ext ELSE cl.ext END,
         CASE WHEN kh.id < coalesce(ch.id, 9223372036854775807) THEN kh.id ELSE ch.id END,
         CASE WHEN kh.id < coalesce(ch.id, 9223372036854775807) THEN kh.ext ELSE ch.ext END
    FROM (SELECT 1) one
    LEFT JOIN cl ON true LEFT JOIN ch ON true LEFT JOIN kl ON true LEFT JOIN kh ON true
$function$;

REVOKE EXECUTE ON FUNCTION public.topshot_id_neighbours(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_id_neighbours(bigint) TO postgres, service_role;

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
    SELECT i.*, nb.lo_id, nb.lo_ext, nb.hi_id, nb.hi_ext,
           EXISTS (SELECT 1 FROM public.topshot_moment_id_editions x WHERE x.id = i.id) AS has_record
    FROM inf i
    -- 2026-11-25: neighbours from the corpus AND the chain checkpoint (topshot_id_neighbours)
    LEFT JOIN LATERAL public.topshot_id_neighbours(i.id) nb ON true
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
    SELECT c.*, nb.lo_id, nb.lo_ext, nb.hi_id, nb.hi_ext
    FROM cand c
    -- 2026-11-25: neighbours from the corpus AND the chain checkpoint (topshot_id_neighbours)
    LEFT JOIN LATERAL public.topshot_id_neighbours(c.id) nb ON true
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
