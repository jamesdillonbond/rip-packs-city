-- APPLIED LIVE 2026-08-28 22:52:43Z from Cowork (cloud, NO-PUSH session). COMMIT ONLY — DO NOT RE-APPLY.
-- Version recorded by apply_migration: 20260828225243
--
-- Fixup #1 of 2 for my own defect in 20260828225210: that migration's annotation shipped the
-- placeholder string "22:5xZ" instead of a real time. Superseded in the same minute by
-- 20260828225258, which corrects 22:53Z -> the exact 22:52Z. Both are kept because both APPLIED;
-- collapsing them would leave the register disagreeing with the note.
--
-- REVERT: none needed in isolation — reverting 20260828225210 (restore from
--   public.audit_20260828_grail_watchlist_note_backup) undoes this too.

DO $$
DECLARE n int;
BEGIN
  UPDATE public.pipeline_cadence_watchlist
     SET notes = replace(notes, '2026-08-28 22:5xZ', '2026-08-28 22:53Z')
   WHERE pipeline = 'refresh-pack-grail-metrics-mv'
     AND notes LIKE '%2026-08-28 22:5xZ%';

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'placeholder fix matched % rows, expected exactly 1', n;
  END IF;
END $$;
