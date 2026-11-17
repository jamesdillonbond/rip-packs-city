-- 2026-09-24 (PT) — companion to 20260925060147: the same 123 Top Shot team
-- moments also carried the sentinel in editions.name ("Unknown (error loading)
-- — The Champion's Path"). Every other team moment in the catalogue is named
-- by its set ("Skyline", "Dynamic Duos"), so these become their set name too.
-- All 123 match the exact shape '<sentinel> — <set_name>' (asserted below).
-- Revert: UPDATE editions e SET name = 'Unknown (error loading) — ' || e.set_name
--   WHERE e.id IN (SELECT edition_id FROM audit_20260924_unknown_player_editions_backup);
DO $$
DECLARE v_n int; v_upd int;
BEGIN
  SELECT count(*) INTO v_n FROM public.editions WHERE name LIKE 'Unknown (error loading)%';
  IF v_n <> (SELECT count(*) FROM public.editions
             WHERE name = 'Unknown (error loading) — ' || set_name
               AND id IN (SELECT edition_id FROM public.audit_20260924_unknown_player_editions_backup)) THEN
    RAISE EXCEPTION 'sentinel-named editions (%) are not all the backed-up team moments in the expected shape', v_n;
  END IF;
  UPDATE public.editions SET name = set_name, updated_at = now()
   WHERE name = 'Unknown (error loading) — ' || set_name
     AND id IN (SELECT edition_id FROM public.audit_20260924_unknown_player_editions_backup);
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  IF v_upd <> v_n THEN RAISE EXCEPTION 'renamed % of %', v_upd, v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.editions WHERE name LIKE 'Unknown (error loading)%' OR player_name LIKE 'Unknown (error loading)%') THEN
    RAISE EXCEPTION 'a sentinel survived in editions';
  END IF;
END $$;
