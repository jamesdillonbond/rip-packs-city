-- audit_20261110: RECORD-ONLY. idx_panini_serials_owner_lower_cover was built with CREATE INDEX CONCURRENTLY from a
-- one-off pg_cron job (jobid 855, 2026-11-10 11:59 AM -> 12:01 PM PT, 2 m 13 s, 442 MB, indisvalid), under a
-- temporarily raised postgres statement_timeout (900s) that was RESET straight after; the job was unscheduled
-- (0 zz-* jobs left; pg_db_role_setting for postgres back to search_path + track_io_timing only). In prod this
-- file is a no-op that asserts the index is valid.
--
-- Why (inbox 2026-11-10T1910Z, /api/panini-set-progress RPC_READ_TIMEOUT): every Panini "what does this username
-- hold" read (`mine` CTE in panini_set_progress_products / _for_product / _all) needs edition_external_id,
-- captured_at and serial_state per held serial. The only key on lower(owner) carried INCLUDE (owner), so a big
-- holder paid one heap fetch per card on a 10 GB table: 'Jascar' (141k cards) = 84.1 s / 195,291 blocks for the
-- Sets-tab picker, i.e. that collector's Sets tab could never load. Index-only now: the owner read is 4,795 blocks
-- (4.4 s fully cold on the fresh index), the picker 173 ms / 8,802 blocks.
--
-- It is a SUPERSET of idx_panini_serials_owner_lower_incl (same key and predicate; INCLUDE adds edition_external_id,
-- captured_at, serial_state). _incl is left in place: drop it only once its idx_scan stops moving (baseline
-- 260,775 at 12:01 PM PT 11-10), the same statistical ground 20261015222529 used.
--
-- Revert: DROP INDEX CONCURRENTLY public.idx_panini_serials_owner_lower_cover;  (from a one-off pg_cron job or the SQL editor)

CREATE INDEX IF NOT EXISTS idx_panini_serials_owner_lower_cover ON public.panini_card_serials USING btree (lower(owner)) INCLUDE (owner, edition_external_id, captured_at, serial_state) WHERE (owner <> ''::text);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_panini_serials_owner_lower_cover' AND i.indisvalid AND i.indisready
  ) THEN
    RAISE EXCEPTION 'idx_panini_serials_owner_lower_cover is missing or not valid';
  END IF;
END $$;
