-- Replace the placeholder "22:5xZ" left in the previous migration's annotation with the real
-- apply time. Guarded: asserts the placeholder is present exactly once before replacing.
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