-- The prior fix wrote 22:53Z; the annotating migration (20260828225210) actually applied at
-- 22:52:10Z. Correct it so the note's own stamp matches the migration register exactly.
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