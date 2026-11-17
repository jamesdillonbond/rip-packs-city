-- 2026-09-25 (PT) — three Top Shot sets carried series NULL while every one of
-- their editions agreed on one series ("2023-24 Honors (Diced)" → 6, "WNBA
-- Hustle & Show" → 8, …): the set page said "Part of Series —" and the sets
-- list could not place them. The set takes its editions' single series; a set
-- whose editions disagree or carry no series is left alone (13 such, created
-- 09-24 by a writer that names a set before the catalog backfill knows its
-- series — see known-issues #137). Idempotent.
-- Revert: UPDATE sets SET series = NULL WHERE id IN (the three ids in the
-- NOTICE below) — or leave it; the value is the editions' own.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT s.id, s.name,
           (SELECT min(e.series) FROM public.editions e WHERE e.set_id = s.id AND e.series IS NOT NULL) AS ed_series
    FROM public.sets s
    WHERE s.series IS NULL
      AND (SELECT count(DISTINCT e.series) FROM public.editions e WHERE e.set_id = s.id AND e.series IS NOT NULL) = 1
  LOOP
    UPDATE public.sets SET series = r.ed_series WHERE id = r.id;
    n := n + 1;
    RAISE NOTICE 'set % (%) series := %', r.name, r.id, r.ed_series;
  END LOOP;
  RAISE NOTICE 'filled % sets', n;
END $$;
