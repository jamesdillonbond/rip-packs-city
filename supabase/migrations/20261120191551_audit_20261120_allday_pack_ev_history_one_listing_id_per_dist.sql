-- 2026-11-20 (PT) — All Day pack EV: one pack_listing_id per distribution.
--
-- WHAT BROKE. pg_cron `rpc-allday-ev-corrected-refresh` (jobid 65) failed at 10:47 AM PT:
--   duplicate key value violates unique constraint "mv_allday_pack_ev_corrected_dist" (dist_id)=(165)
-- so mv_allday_pack_ev_corrected (the All Day pack EV every pack page reads) stopped
-- refreshing and would have failed on every later tick.
--
-- WHY. compute-allday-pack-ev v11 (2026-11-18) moved its source from the Studio GraphQL to
-- Dapper Atlas and writes pack_ev_history.pack_listing_id = the node's `uuid`. For most
-- distributions the two hosts give the same uuid; for 48 so far (the tail of the walk,
-- offsets >= 3000, reached 10:38-11:08 AM PT today: Playbook reward packs) Atlas gives a
-- DIFFERENT one. pack_ev_latest is DISTINCT ON (pack_listing_id), so those distributions
-- now have two "latest" rows (the 11-17 Studio row and today's Atlas row) and the MV's
-- LEFT JOIN on dist_id doubles them. Before today no distribution in ANY collection had
-- two listing ids (0 of 3,155 All Day dists since May; 0 of 1,391 elsewhere in 30 days).
-- About 130 more distributions are still to be walked today.
--
-- FIX, at the write layer. The Atlas uuid is the identity going forward (Studio has been
-- dead since 11-17, and pack_ask_state already carries the Atlas ids: 32 rows on the new
-- ids, 0 on the old). An AFTER INSERT trigger re-keys a distribution's earlier history
-- rows to the id just written whenever they differ, so a distribution has one id however
-- many more flip. Scoped to All Day: it is the only collection whose source changed.
-- One-time: the 3,291 history rows of the 48 already-flipped distributions are re-keyed.
--
-- Revert: DROP TRIGGER pack_ev_history_allday_one_listing_id_trg ON public.pack_ev_history;
--         DROP FUNCTION public.pack_ev_history_allday_one_listing_id();
--         (the re-key is not reverted: the old ids no longer exist upstream.)

CREATE OR REPLACE FUNCTION public.pack_ev_history_allday_one_listing_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Uses idx_pack_ev_history_collection_dist_time (collection_id, dist_id, ...).
  UPDATE public.pack_ev_history h
     SET pack_listing_id = NEW.pack_listing_id
   WHERE h.collection_id = NEW.collection_id
     AND h.dist_id = NEW.dist_id
     AND h.pack_listing_id IS DISTINCT FROM NEW.pack_listing_id;
  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pack_ev_history_allday_one_listing_id() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pack_ev_history_allday_one_listing_id_trg ON public.pack_ev_history;
CREATE TRIGGER pack_ev_history_allday_one_listing_id_trg
  AFTER INSERT ON public.pack_ev_history
  FOR EACH ROW
  WHEN (NEW.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND NEW.dist_id IS NOT NULL AND NEW.pack_listing_id IS NOT NULL)
  EXECUTE FUNCTION public.pack_ev_history_allday_one_listing_id();

COMMENT ON FUNCTION public.pack_ev_history_allday_one_listing_id() IS
  'All Day: a distribution has ONE pack_listing_id. When the writer inserts a row whose id differs from the distribution''s earlier rows (Studio uuid vs Atlas uuid, 2026-11-20), the earlier rows are re-keyed to the new id. Without it pack_ev_latest holds two rows per distribution and mv_allday_pack_ev_corrected cannot refresh.';

-- One-time re-key of the distributions that already flipped; guarded on what was measured.
DO $$
DECLARE v_dists int; v_rows int; v_left int;
BEGIN
  CREATE TEMP TABLE _flip ON COMMIT DROP AS
  SELECT dist_id, pack_listing_id AS new_id
  FROM (
    SELECT dist_id, pack_listing_id,
           row_number() OVER (PARTITION BY dist_id ORDER BY max(snapshotted_at) DESC) AS rn,
           count(*) OVER (PARTITION BY dist_id) AS n
    FROM public.pack_ev_history
    WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND dist_id IS NOT NULL AND pack_listing_id IS NOT NULL
    GROUP BY dist_id, pack_listing_id
  ) q WHERE n > 1 AND rn = 1;
  SELECT count(*) INTO v_dists FROM _flip;
  IF v_dists > 400 THEN RAISE EXCEPTION 'expected a few dozen flipped distributions, found %', v_dists; END IF;

  UPDATE public.pack_ev_history h
     SET pack_listing_id = f.new_id
    FROM _flip f
   WHERE h.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
     AND h.dist_id = f.dist_id
     AND h.pack_listing_id IS DISTINCT FROM f.new_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(*) INTO v_left FROM (
    SELECT dist_id FROM public.pack_ev_history
    WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid AND dist_id IS NOT NULL
    GROUP BY dist_id HAVING count(DISTINCT pack_listing_id) > 1) z;
  IF v_left <> 0 THEN RAISE EXCEPTION '% distributions still carry two listing ids', v_left; END IF;
  RAISE NOTICE 're-keyed % rows across % distributions', v_rows, v_dists;
END $$;
