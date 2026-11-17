-- APPLIED LIVE 2026-08-28 22:52:58Z from Cowork (cloud, NO-PUSH session). COMMIT ONLY — DO NOT RE-APPLY.
-- Version recorded by apply_migration: 20260828225258
--
-- Fixup #2 of 2 for 20260828225210. Fixup #1 (20260828225243) wrote 22:53Z, but the annotating
-- migration actually applied at 22:52:10Z. Corrected so the note's own stamp matches the migration
-- register exactly rather than being a minute ahead of it.
--
-- REVERT: none needed in isolation — reverting 20260828225210 (restore from
--   public.audit_20260828_grail_watchlist_note_backup) undoes this too.

DO $$
DECLARE n int;
BEGIN
  UPDATE public.pipeline_cadence_watchlist
     SET notes = replace(notes, '2026-08-28 22:53Z', '2026-08-28 22:52Z')
   WHERE pipeline = 'refresh-pack-grail-metrics-mv'
     AND notes LIKE '%2026-08-28 22:53Z%';

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'timestamp correction matched % rows, expected exactly 1', n;
  END IF;
END $$;

-- POST-FLIGHT, verified from OUTSIDE 2026-08-28 22:54Z:
--   has_placeholder = false · has_wrong_stamp (22:53Z) = false · has_correct_stamp (22:52Z) = true
--   note_len = 2370 (unchanged by both fixups, as a same-length replace should be)
